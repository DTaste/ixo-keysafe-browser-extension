const fs = require('fs')
const path = require('path')
const pump = require('pump')
const LocalMessageDuplexStream = require('post-message-stream')
const PongStream = require('ping-pong-stream/pong')
const ObjectMultiplex = require('obj-multiplex')
const extension = require('extensionizer')
const PortStream = require('./lib/port-stream.js')

const inpageContent = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'chrome', 'inpage.js')).toString()
const inpageSuffix = '//# sourceURL=' + extension.extension.getURL('inpage.js') + '\n'
const inpageBundle = inpageContent + inpageSuffix

// Eventually this streaming injection could be replaced with:
// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Language_Bindings/Components.utils.exportFunction
//
// But for now that is only Firefox
// If we create a FireFox-only code path using that API,
// MetaMask will be much faster loading and performant on Firefox.

if (shouldInjectWeb3()) {
  setupInjection()
  setupStreams()
}

/**
 * Creates a script tag that injects inpage.js
 */
function setupInjection () {
  try {
    // inject in-page script
    var scriptTag = document.createElement('script')
    scriptTag.textContent = inpageBundle
    scriptTag.onload = function () { this.parentNode.removeChild(this) }
    var container = document.head || document.documentElement
    // append as first child
    container.insertBefore(scriptTag, container.children[0])
  } catch (e) {
    console.error('MetamaskII injection failed.', e)
  }
}

/**
 * Sets up two-way communication streams between the
 * browser extension and local per-page browser context
 */
function setupStreams () {
  // setup communication to page and plugin
  const pageStream = new LocalMessageDuplexStream({
    name: 'contentscriptixo',
    target: 'inpageixo',
  })
  const pluginPort = extension.runtime.connect({ name: 'contentscriptixo' })
  const pluginStream = new PortStream(pluginPort)

  // forward communication plugin->inpage
  pump(
    pageStream,
    pluginStream,
    pageStream,
    (err) => logStreamDisconnectWarning('MetaMaskII Contentscript Forwarding', err)
  )

  // setup local multistream channels
  const mux = new ObjectMultiplex()
  mux.setMaxListeners(25)

  pump(
    mux,
    pageStream,
    mux,
    (err) => logStreamDisconnectWarning('MetaMaskII Inpage', err)
  )
  pump(
    mux,
    pluginStream,
    mux,
    (err) => logStreamDisconnectWarning('MetaMaskII Background', err)
  )

  // connect ping stream
  const pongStream = new PongStream({ objectMode: true })
  pump(
    mux,
    pongStream,
    mux,
    (err) => logStreamDisconnectWarning('MetaMaskII PingPongStream', err)
  )

  // connect phishing warning stream
  const phishingStream = mux.createStream('phishing')
  phishingStream.once('data', redirectToPhishingWarning)

  // ignore unused channels (handled by background, inpage)
  mux.ignoreStream('provider')
  mux.ignoreStream('publicConfig')
}


/**
 * Error handler for page to plugin stream disconnections
 *
 * @param {string} remoteLabel Remote stream name
 * @param {Error} err Stream connection error
 */
function logStreamDisconnectWarning (remoteLabel, err) {
  let warningMsg = `MetamaskIIContentscript - lost connection to ${remoteLabel}`
  if (err) warningMsg += '\n' + err.stack
  console.warn(warningMsg)
}

/**
 * Determines if Web3 should be injected
 *
 * @returns {boolean} {@code true} if Web3 should be injected
 */
function shouldInjectWeb3 () {
  return doctypeCheck() && suffixCheck()
    && documentElementCheck() && !blacklistedDomainCheck()
}

/**
 * Checks the doctype of the current document if it exists
 *
 * @returns {boolean} {@code true} if the doctype is html or if none exists
 */
function doctypeCheck () {
  const doctype = window.document.doctype
  if (doctype) {
    return doctype.name === 'html'
  } else {
    return true
  }
}

/**
 * Checks the current document extension
 *
 * @returns {boolean} {@code true} if the current extension is not prohibited
 */
function suffixCheck () {
  var prohibitedTypes = ['xml', 'pdf']
  var currentUrl = window.location.href
  var currentRegex
  for (let i = 0; i < prohibitedTypes.length; i++) {
    currentRegex = new RegExp(`\\.${prohibitedTypes[i]}$`)
    if (currentRegex.test(currentUrl)) {
      return false
    }
  }
  return true
}

/**
 * Checks the documentElement of the current document
 *
 * @returns {boolean} {@code true} if the documentElement is an html node or if none exists
 */
function documentElementCheck () {
  var documentElement = document.documentElement.nodeName
  if (documentElement) {
    return documentElement.toLowerCase() === 'html'
  }
  return true
}

/**
 * Checks if the current domain is blacklisted
 * 
 * @returns {boolean} {@code true} if the current domain is blacklisted
 */
function blacklistedDomainCheck () {
  var blacklistedDomains = [
    'uscourts.gov',
    'dropbox.com',
    'webbyawards.com',
    'cdn.shopify.com/s/javascripts/tricorder/xtld-read-only-frame.html',
  ]
  var currentUrl = window.location.href
  var currentRegex
  for (let i = 0; i < blacklistedDomains.length; i++) {
    const blacklistedDomain = blacklistedDomains[i].replace('.', '\\.')
    currentRegex = new RegExp(`(?:https?:\\/\\/)(?:(?!${blacklistedDomain}).)*$`)
    if (!currentRegex.test(currentUrl)) {
      return true
    }
  }
  return false
}

/**
 * Redirects the current page to a phishing information page
 */
function redirectToPhishingWarning () {
  console.log('MetaMaskII - redirecting to phishing warning')
  window.location.href = 'https://metamask.io/phishing.html'
}

/*
Send a message to the page script.
*/
function postMessageFromContentScript(method, response, error) {
  window.postMessage({
    origin: "ixo-cm",
    method,
    response,
    error
  }, "*");
}

/*
Listen for messages from the page.
If the message was from the page script, forward it to background.js.
*/
window.addEventListener("message", (event) => {
  const MONITORED_METHODS = ['ixo-info', 'ixo-sign']

  if (event.source == window && event.data && event.data.origin == 'ixo-dapp') {
      const message = event.data.message
      var port = extension.runtime.connect({name: event.data.origin});    
      port.postMessage(message);

      port.onMessage.addListener(function(reply) {
        if (MONITORED_METHODS.find(m => m===reply.method) || reply.error) {
          console.debug(`contentscript received reply ${JSON.stringify(reply)}`)
          postMessageFromContentScript(reply.method, reply.response, reply.error)
        }
      });
    }
});