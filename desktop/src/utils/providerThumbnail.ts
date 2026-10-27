/** Small public CDN images let search covers load without waiting for the server's thumbnail queue. */
export function providerThumbnail(source: string): string {
  let url: URL;
  try { url = new URL(source); } catch { return source; }
  if (url.protocol !== "https:") return source;
  if (url.hostname === "resources.tidal.com") {
    url.pathname = url.pathname.replace(/\/\d+x\d+\.jpg$/, "/320x320.jpg");
  } else if (url.hostname === "static.qobuz.com") {
    url.pathname = url.pathname.replace(/_(?:max|\d+)\.jpg$/, "_300.jpg");
  }
  return url.href;
}
