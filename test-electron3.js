const electron = require("electron");
console.log("Type:", typeof electron);
console.log("Keys:", Object.keys(electron).slice(0, 30));
console.log("Has app:", "app" in electron);
console.log("app type:", typeof electron.app);
if (electron.app) { console.log("app.whenReady:", typeof electron.app.whenReady); electron.app.quit(); }
