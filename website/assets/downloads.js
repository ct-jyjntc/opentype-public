/* Shared by the home page and /downloads/: the package list, the latest stable manifest, and device detection. */
(function () {
  "use strict";
  var PACKAGES = {
    mac: { url: "/downloads/macos-arm64", os: "mac", name: "macOS（Apple 芯片）", short: "Apple 芯片", req: "macOS 13+ · M1 及更新的芯片", file: "DMG" },
    "mac-x64": { url: "/downloads/macos-x64", os: "mac", name: "macOS（Intel 芯片）", short: "Intel 芯片", req: "macOS 13+ · Intel 处理器", file: "DMG" },
    win: { url: "/downloads/windows-x64", os: "win", name: "Windows（x64）", short: "x64", req: "Windows 10/11 · Intel 或 AMD 处理器", file: "EXE" },
    "win-arm64": { url: "/downloads/windows-arm64", os: "win", name: "Windows（ARM）", short: "ARM", req: "Windows 11 · 骁龙等 ARM 处理器", file: "EXE" },
  };

  /** Latest stable manifest, keeping only the packages this page knows. Resolves null on failure. */
  function loadManifest() {
    return fetch("/downloads/manifest.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (release) {
        var files = {};
        Object.keys(PACKAGES).forEach(function (k) {
          var f = release && release.files && release.files[k];
          if (f && f.url === PACKAGES[k].url && Number.isSafeInteger(f.size) && f.size > 0) files[k] = f;
        });
        return Object.keys(files).length ? { version: String(release.version || ""), files: files } : null;
      })
      .catch(function () { return null; });
  }

  function webglRenderer() {
    try {
      var gl = document.createElement("canvas").getContext("webgl");
      var ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "") : "";
    } catch (e) { return ""; }
  }

  /**
   * Best package key for this device, or null for phones, tablets and other systems.
   * Chromium browsers report the CPU architecture; elsewhere a Mac falls back to the GPU name,
   * and an undetermined Mac or PC gets the most common build (Apple silicon / x64).
   */
  function detect() {
    var nav = navigator, ua = nav.userAgent || "";
    var plat = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || "";
    if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Mac/i.test(plat) && nav.maxTouchPoints > 1)) return Promise.resolve(null);
    var os = /Mac/i.test(plat + ua) ? "mac" : /Win/i.test(plat + ua) ? "win" : null;
    if (!os) return Promise.resolve(null);
    var pick = function (arm) { return os === "mac" ? (arm === false ? "mac-x64" : "mac") : (arm === true ? "win-arm64" : "win"); };
    var fromGpu = function () {
      if (os !== "mac") return pick(undefined);
      var gpu = webglRenderer();
      return pick(/Apple M\d/i.test(gpu) ? true : /Intel|AMD|Radeon|NVIDIA|GeForce/i.test(gpu) ? false : undefined);
    };
    var uad = nav.userAgentData;
    if (!uad || typeof uad.getHighEntropyValues !== "function") return Promise.resolve(fromGpu());
    return uad.getHighEntropyValues(["architecture"])
      .then(function (v) { return v.architecture === "arm" ? pick(true) : v.architecture === "x86" ? pick(false) : fromGpu(); })
      .catch(fromGpu);
  }

  function sizeMB(bytes) { return Math.round(bytes / 1048576) + " MB"; }

  function start(btn, url, label) {
    var a = document.createElement("a");
    a.href = url; a.setAttribute("download", ""); a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    btn.textContent = "正在下载…";
    setTimeout(function () { btn.textContent = label; }, 2000);
  }

  window.OpenTypeDownloads = { PACKAGES: PACKAGES, loadManifest: loadManifest, detect: detect, sizeMB: sizeMB, start: start };
})();
