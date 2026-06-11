export function assertModuleSingleton(name, url) {
  try {
    var host = window.location && window.location.hostname;
    var isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocalhost) return;

    var registry = window.__ORIGIN_MODULE_SINGLETONS__;
    if (!registry) {
      registry = {};
      window.__ORIGIN_MODULE_SINGLETONS__ = registry;
    }

    var firstUrl = registry[name];
    if (!firstUrl) {
      registry[name] = url;
      return;
    }
    if (firstUrl === url) return;

    var message = "[ORIGIN_MODULE_SINGLETON] " + name + " loaded by multiple URLs: " + firstUrl + " <> " + url;
    window.__ORIGIN_MODULE_SINGLETON_VIOLATION__ = { name: name, firstUrl: firstUrl, secondUrl: url, message: message };
    console.error(message);
  } catch (_) {
    // Dev-only guard; never block the app when diagnostics fail.
  }
}
