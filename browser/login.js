import RFBModule from "@novnc/novnc/lib/rfb.js";
const RFB = RFBModule.default ?? RFBModule;
const path = location.pathname.replace(/index\.html$/, "") + "websockify";
const rfb = new RFB(
  document.getElementById("screen"),
  "wss://" + location.host + path,
);
rfb.scaleViewport = true;
rfb.addEventListener("disconnect", () => {
  document.getElementById("screen").textContent =
    "Browser disconnected. Return to the login page to reconnect.";
});
