const NodeHelper = require("node_helper");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { spawn, execFile } = require("child_process");

const SERVICES = {
	RESTART_APP: "magicmirror",
	RESTART_WORDBOT: "wordbot"
};

const splitNmcli = (line) => line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ":").replace(/\\\\/g, "\\"));

const nmcli = (args) => new Promise((resolve, reject) => {
	execFile("nmcli", ["-t", ...args], { timeout: 10000 }, (err, stdout) => {
		if (err) {
			reject(err);
		} else {
			resolve(stdout.split("\n").filter(Boolean).map(splitNmcli));
		}
	});
});

const savedWifi = async () => (await nmcli(["-f", "NAME,TYPE", "connection", "show"]))
	.filter(([, type]) => type === "802-11-wireless")
	.map(([name]) => name);

module.exports = NodeHelper.create({
	start () {
		this.serverLines = [];
		this.followJournal();
	},

	pushServerLine (line) {
		this.serverLines.push(line);
		if (this.serverLines.length > 500) {
			this.serverLines.shift();
		}
		this.sendSocketNotification("SERVER_LOG", { lines: [line] });
	},

	followJournal () {
		const proc = spawn("journalctl", ["-f", "-n", "200", "-o", "short", "--no-pager", "-u", "magicmirror", "-u", "wordbot"]);
		readline.createInterface({ input: proc.stdout }).on("line", (line) => this.pushServerLine(line));
		readline.createInterface({ input: proc.stderr }).on("line", (line) => this.pushServerLine(`[journalctl] ${line}`));
		proc.on("error", (err) => this.pushServerLine(`[journalctl] ${err.message}`));
		proc.on("close", (code) => {
			if (code !== null) {
				setTimeout(() => this.followJournal(), 10000);
			}
		});
	},

	async sendWifiStatus () {
		try {
			const [saved, scan] = await Promise.all([
				savedWifi(),
				nmcli(["-f", "IN-USE,SSID,SIGNAL", "dev", "wifi", "list", "--rescan", "no"])
			]);
			const seen = new Map();
			scan.forEach(([inUse, ssid, signal]) => {
				if (!ssid) {
					return;
				}
				const entry = { ssid, signal: Number(signal) || 0, active: inUse === "*", saved: saved.includes(ssid) };
				const prev = seen.get(ssid);
				if (!prev || entry.active || (!prev.active && entry.signal > prev.signal)) {
					seen.set(ssid, entry);
				}
			});
			const networks = [...seen.values()].sort((a, b) => b.active - a.active || b.signal - a.signal);
			this.sendSocketNotification("WIFI_STATUS", { networks });
		} catch (err) {
			this.sendSocketNotification("WIFI_STATUS", { error: err.message });
		}
	},

	async connectWifi (ssid) {
		try {
			if (!(await savedWifi()).includes(ssid)) {
				throw new Error("Network is not saved on this device");
			}
			spawn("sudo", ["-n", "nmcli", "connection", "up", "id", ssid], {
				detached: true,
				stdio: "ignore"
			}).unref();
		} catch (err) {
			this.sendSocketNotification("WIFI_STATUS", { error: err.message });
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "GET_WALLPAPERS") {
			const dir = path.resolve(__dirname, "../../config/darkwallpapers");
			try {
				const files = fs.readdirSync(dir)
					.filter(f => /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(f))
					.sort();
				this.sendSocketNotification("WALLPAPERS", files);
			} catch {
				this.sendSocketNotification("WALLPAPERS", []);
			}
		} else if (SERVICES[notification]) {
			spawn("sudo", ["-n", "systemctl", "restart", SERVICES[notification]], {
				detached: true,
				stdio: "ignore"
			}).unref();
		}
	}
});
