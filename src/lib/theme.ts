/** localStorage key and the blocking boot script that paints the right issue. */

export const THEME_KEY = "trendwire-theme";

/**
 * Runs before first paint. Reads a stored choice, otherwise follows the OS.
 * Kept as a string so the bookmark confirmation page can use the same boot.
 */
export const THEME_INIT_SCRIPT = `(function(){
  var k=${JSON.stringify(THEME_KEY)};
  var t=null;
  try {
    var q=new URLSearchParams(location.search).get("theme");
    if (q==="light"||q==="dark") t=q;
  } catch (e) {}
  if (!t) {
    try { t=localStorage.getItem(k); } catch (e2) {}
  }
  if (t!=="light" && t!=="dark") {
    t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
  }
  document.documentElement.setAttribute("data-theme", t);
  document.documentElement.style.colorScheme=t;
})();`;
