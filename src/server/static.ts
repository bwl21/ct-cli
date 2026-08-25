export const bootstrapScript = `(() => {
  const secret = location.hash.startsWith("#bootstrap=")
    ? decodeURIComponent(location.hash.slice("#bootstrap=".length))
    : null;
  if (!secret) return;
  fetch("/api/session/bootstrap", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret })
  }).then((response) => {
    if (!response.ok) throw new Error("Session bootstrap failed");
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
  }).catch(() => {
    document.querySelector("main").textContent = "Die lokale ct-Sitzung konnte nicht gestartet werden.";
  });
})();`;

export const placeholderHtml = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>ct</title>
  </head>
  <body>
    <main>ct UI wird geladen …</main>
    <script src="/bootstrap.js" defer></script>
  </body>
</html>`;
