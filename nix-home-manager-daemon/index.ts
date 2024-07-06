import { debounce, throttle } from "lodash";
import notifier from "node-notifier";
import { execSync } from "node:child_process";
import { watch } from "node:fs";

const homeManagerDir = `${__dirname}/../home-manager`;
const sendNotification = (message: string) => {
  const notification = `Home Manager Daemon - ${message}`;
  console.log(`Notification: ${notification}`);
  notifier.notify(notification);
};

const runHomeManagerSwitch = () => {
  try {
    sendNotification("Starting Home Manager switch...");
    execSync(
      `nix run home-manager/release-24.05 -- switch --flake ${homeManagerDir}#home`,
      { stdio: "inherit" }
    );
    sendNotification("Home Manager switch executed successfully.");
    console.log("Home Manager switch executed successfully.");
  } catch (error) {
    sendNotification("Error executing Home Manager switch.");
    console.error("Error executing Home Manager switch:", error);
  }
};

const throttledAndDebouncedRun = debounce(
  throttle(runHomeManagerSwitch, 2000),
  2000
);

async function main() {
  console.log("Starting Home Manager Daemon...");
  console.log(notifier);
  sendNotification("Home Manager Daemon started");
  watch(homeManagerDir, { recursive: true }, (eventType, filename) => {
    if (filename) {
      console.log(`File changed: ${filename}`);
      throttledAndDebouncedRun();
    }
  });
}
main();
