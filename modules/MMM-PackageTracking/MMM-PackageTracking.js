Module.register("MMM-PackageTracking", {
	defaults: {
		gmail: null,
		packages: [],
		refreshInterval: 30 * 60 * 1000,
		emailScanInterval: 15 * 60 * 1000,
		showDelivered: true,
		daysToShowDelivered: 3,
		maxPackages: 10,
		animationSpeed: 500
	},

	getStyles () {
		return [this.file("MMM-PackageTracking.css"), "font-awesome.css"];
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.trackingData = [];
		this.loaded = false;
		this.error = null;
		this.gmailConnected = !this.config.gmail;

		this.sendSocketNotification("INIT_TRACKING", {
			gmail: this.config.gmail,
			packages: this.config.packages,
			address: config.address,
			port: config.port,
			emailScanInterval: this.config.emailScanInterval
		});

		this.scheduleRefresh();

		document.addEventListener("mm-activity", () => {
			if (this._resetTimer) clearTimeout(this._resetTimer);
			this._resetTimer = setTimeout(() => {
				this.updateDom(0).then(() => {
					const wrapper = document.getElementById(this.identifier);
					if (!wrapper) return;
					const list = wrapper.querySelector(".pkg-list");
					if (list) list.scrollTop = 0;
				});
			}, config.resetTimeout);
		});
	},

	getTemplate () {
		return "MMM-PackageTracking.njk";
	},

	getDom () {
		return this._super().then((dom) => {
			const list = dom.querySelector(".pkg-list");
			const indicator = dom.querySelector(".pkg-scroll-indicator");
			if (list) {
				const updateIndicator = () => {
					if (!indicator) return;
					const canScroll = list.scrollHeight > list.clientHeight;
					const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
					indicator.classList.toggle("visible", canScroll && !atBottom);
				};
				list.addEventListener("scroll", () => {
					document.dispatchEvent(new Event("mm-activity"));
					updateIndicator();
				});
				updateIndicator();
			}
			return dom;
		});
	},

	getTemplateData () {
		const now = Date.now();
		const cutoff = this.config.daysToShowDelivered * 24 * 60 * 60 * 1000;

		let packages = this.trackingData;
		if (!this.config.showDelivered) {
			packages = packages.filter((p) => p.status !== "Delivered" && p.status !== "Presumed");
		} else if (this.config.daysToShowDelivered > 0) {
			packages = packages.filter((p) => {
				if (p.status !== "Delivered" && p.status !== "Presumed") return true;
				if (!p.deliveredAt) return true;
				return now - new Date(p.deliveredAt).getTime() < cutoff;
			});
		}

		packages = packages.slice(0, this.config.maxPackages);

		return {
			packages,
			loaded: this.loaded,
			error: this.error,
			gmailConnected: this.gmailConnected,
			hasGmail: !!this.config.gmail,
			config: this.config,
			formatDelivery: this.formatDelivery.bind(this),
			statusIcon: this.statusIcon,
			statusClass: this.statusClass,
			timeAgo: this.timeAgo
		};
	},

	scheduleRefresh () {
		setInterval(() => {
			this.sendSocketNotification("FETCH_TRACKING", {});
		}, this.config.refreshInterval);
	},

	notificationReceived (notification) {
		if (notification === "MODULE_DOM_UPDATED") {
			const wrapper = document.getElementById(this.identifier);
			if (!wrapper) return;
			const list = wrapper.querySelector(".pkg-list");
			const indicator = wrapper.querySelector(".pkg-scroll-indicator");
			if (list && indicator) {
				const canScroll = list.scrollHeight > list.clientHeight;
				const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
				indicator.classList.toggle("visible", canScroll && !atBottom);
			}
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "TRACKING_DATA") {
			this.trackingData = payload;
			this.loaded = true;
			this.error = null;
			this.updateDom(this.config.animationSpeed);
		} else if (notification === "TRACKING_ERROR") {
			this.error = payload.message;
			this.loaded = true;
			this.updateDom();
		} else if (notification === "GMAIL_STATUS") {
			this.gmailConnected = payload.connected;
			this.updateDom(this.config.animationSpeed);
		}
	},

	statusIcon (status) {
		const icons = {
			Pending: "fa-clock-o",
			InTransit: "fa-plane",
			OutForDelivery: "fa-truck",
			Delivered: "fa-check-circle",
			Presumed: "fa-check",
			Exception: "fa-exclamation-triangle"
		};
		return icons[status] || "fa-question-circle";
	},

	statusClass (status) {
		const classes = {
			Pending: "pkg-status-pending",
			InTransit: "pkg-status-transit",
			OutForDelivery: "pkg-status-out",
			Delivered: "pkg-status-delivered",
			Presumed: "pkg-status-presumed",
			Exception: "pkg-status-exception"
		};
		return classes[status] || "pkg-status-pending";
	},

	formatDelivery (pkg) {
		if (pkg.status === "Delivered") {
			const d = pkg.deliveredAt || pkg.expectedDelivery;
			return d ? `Delivered ${this.formatDateShort(d)}` : "Delivered";
		}
		if (pkg.status === "Presumed") {
			const d = pkg.expectedDelivery || pkg.deliveredAt;
			return d ? `Likely delivered ${this.formatDateShort(d)}` : "Likely delivered";
		}

		if (pkg.deliveryWindow?.from && pkg.deliveryWindow?.to && pkg.deliveryWindow.from !== pkg.deliveryWindow.to) {
			return `${this.formatDateShort(pkg.deliveryWindow.from)} – ${this.formatDateShort(pkg.deliveryWindow.to)}`;
		}
		if (pkg.expectedDelivery) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const delivery = new Date(pkg.expectedDelivery + "T00:00:00");
			const diffDays = Math.round((delivery - today) / (24 * 60 * 60 * 1000));

			if (diffDays === 0) return "Arriving today";
			if (diffDays === 1) return "Arriving tomorrow";
			if (diffDays < 0) return `Expected ${this.formatDateShort(pkg.expectedDelivery)}`;
			return `Expected ${this.formatDateShort(pkg.expectedDelivery)}`;
		}
		return null;
	},

	formatDateShort (dateStr) {
		if (!dateStr) return "";
		const d = dateStr.includes("T") ? new Date(dateStr) : new Date(dateStr + "T00:00:00");
		const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
	},

	timeAgo (dateStr) {
		if (!dateStr) return "";
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}
});
