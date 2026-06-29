// react-no-danger is disabled file-wide: deno lint does not honor a `{/* deno-lint-ignore */}`
// directive on a JSX element, and this shell's only `dangerouslySetInnerHTML` is the static-literal
// theme-boot script below (no user input → XSS-safe). Inline is required so it runs before paint;
// an external <script src> would reintroduce the FOUC this exists to prevent.
// deno-lint-ignore-file react-no-danger
import { define } from "../utils.ts";

// No-flash theme boot: runs synchronously in <head> before first paint, so the
// `.dark` class is on <html> before any styled content renders. Default is Auto
// (follows the OS); a stored `compositz-theme` ("light"|"dark"|"system") wins when
// the mode selector is added later — this script already honors it, so the selector
// is purely additive. Also re-applies on live OS changes while in Auto. <html> is
// outside every island, so mutating its class causes no hydration mismatch.
const themeBoot =
  `(function(){try{var mq=matchMedia("(prefers-color-scheme: dark)");function a(){var p=null;try{p=localStorage.getItem("compositz-theme")}catch(e){}var d=p==="dark"||((!p||p==="system")&&mq.matches);document.documentElement.classList.toggle("dark",d)}a();mq.addEventListener("change",a)}catch(e){}})();`;

export default define.page(function App({ Component }) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Compositz</title>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <Component />
      </body>
    </html>
  );
});
