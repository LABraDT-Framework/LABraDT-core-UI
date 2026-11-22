// The UI always works against the real stack (Engine, Gateway, Runtime) through its own controller.
// There are no Demo / Custom environments any more: work is moved between machines by exporting and
// importing a project (System page).
(function (root) {
    "use strict";

    const PREFIX = "labradt-ui:v1:";
    const NAMESPACE = PREFIX + "backend:"; // kept, so workspaces saved by earlier versions stay readable

    function create(nativeStorage) {
        // Blank canvas: data of earlier UI versions on the same origin is not migrated.
        const storage = {
            getItem: key => nativeStorage.getItem(NAMESPACE + key),
            setItem: (key, value) => nativeStorage.setItem(NAMESPACE + key, String(value)),
            removeItem: key => nativeStorage.removeItem(NAMESPACE + key)
        };
        return {
            mode: "backend", label: "Backend", storage, isBackend: true, isDemo: false, hasLiveGateway: true, demoRunning: true,
            gatewayUrl: path => path,
            requireBackend() {},
            authorizeRequest() {}
        };
    }

    const exported = { create, PREFIX };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else {
        const environment = create(root.localStorage);
        environment.fetch = (path, options) => {
            const url = new URL(path, root.location.href);
            if (url.origin !== root.location.origin) throw Error("Only the same-origin UI controller is allowed.");
            return root.fetch(url.pathname + url.search, options);
        };
        environment.PREFIX = PREFIX;
        root.GucEnvironment = environment;
    }
})(typeof window !== "undefined" ? window : globalThis);
