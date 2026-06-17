Module.register("MMM-MusicDisplay", {
	defaults: {
		metadataPipe: "/tmp/shairport-sync-metadata",
		showProgress: true,
		showAlbumArt: true,
		artSize: 100,
		maxWidth: 250,
	},

	start: function () {
		this.metadata = {};
		this.albumArt = null;
		this.progress = null;
		this.playing = false;
		this.lastUpdate = 0;
		this.sendSocketNotification("CONFIG", this.config);

		setInterval(() => {
			if (this.playing && this.progress) {
				this.progress.current += 44100;
				this.updateDom(0);
			}
		}, 1000);
	},

	getStyles: function () {
		return ["MMM-MusicDisplay.css"];
	},

	socketNotificationReceived: function (notification, payload) {
		this.lastUpdate = Date.now();

		if (notification === "METADATA") {
			this.metadata = payload;
			this.playing = true;
			this.updateDom(500);
		} else if (notification === "IMAGE") {
			this.albumArt = payload || null;
			this.updateDom(500);
		} else if (notification === "PROGRESS") {
			const parts = payload.split("/");
			this.progress = {
				start: parseInt(parts[0]),
				current: parseInt(parts[1]),
				end: parseInt(parts[2]),
			};
			this.playing = true;
		} else if (notification === "PAUSE") {
			this.playing = false;
			this.updateDom(500);
		} else if (notification === "RESUME") {
			this.playing = true;
			this.updateDom(500);
		} else if (notification === "STOP") {
			this.playing = false;
			this.metadata = {};
			this.albumArt = null;
			this.progress = null;
			this.updateDom(500);
		}
	},

	makeMarquee: function (text, className) {
		const outer = document.createElement("div");
		outer.className = "marquee-container " + className;
		outer.style.maxWidth = this.config.maxWidth + "px";

		const inner = document.createElement("span");
		inner.className = "marquee-content";
		inner.textContent = text;
		outer.appendChild(inner);

		requestAnimationFrame(() => {
			if (inner.scrollWidth > outer.clientWidth) {
				inner.classList.add("marquee-scroll");
				inner.style.animationDuration = Math.max(inner.scrollWidth / 30, 5) + "s";
			}
		});

		return outer;
	},

	secToTime: function (sec) {
		const min = Math.floor(sec / 60);
		let remain = Math.floor(sec % 60);
		if (remain < 10) remain = "0" + remain;
		return min + ":" + remain;
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "music-wrapper";

		const hasMetadata = this.metadata && Object.keys(this.metadata).length > 0;
		const stale = Date.now() - this.lastUpdate > 120000;

		if (!hasMetadata && !this.playing) {
			wrapper.classList.add("hidden");
			return wrapper;
		}
		if (stale && !this.playing) {
			wrapper.classList.add("hidden");
			return wrapper;
		}

		if (this.config.showAlbumArt && this.albumArt) {
			const img = document.createElement("img");
			img.className = "music-art";
			img.src = this.albumArt;
			img.width = this.config.artSize;
			img.height = this.config.artSize;
			wrapper.appendChild(img);
		}

		const info = document.createElement("div");
		info.className = "music-info";

		if (this.metadata.title) {
			info.appendChild(this.makeMarquee(this.metadata.title, "music-title bright medium"));
		}

		if (this.metadata.artist) {
			info.appendChild(this.makeMarquee(this.metadata.artist, "music-artist small dimmed"));
		}

		if (this.metadata.album) {
			info.appendChild(this.makeMarquee(this.metadata.album, "music-album small dimmed"));
		}

		if (this.config.showProgress && this.progress) {
			const start = this.progress.start / 44100;
			const current = this.progress.current / 44100;
			const end = this.progress.end / 44100;
			let elapsed = current - start;
			const duration = end - start;
			if (elapsed > duration) elapsed = duration;
			if (elapsed < 0) elapsed = 0;

			const bar = document.createElement("progress");
			bar.className = "music-progress";
			bar.value = elapsed;
			bar.max = duration;
			info.appendChild(bar);

			const time = document.createElement("div");
			time.className = "music-time xsmall dimmed";
			time.textContent = this.secToTime(elapsed) + " / " + this.secToTime(duration);
			info.appendChild(time);
		}

		if (!this.playing && hasMetadata) {
			const paused = document.createElement("div");
			paused.className = "music-paused xsmall dimmed";
			paused.textContent = "Paused";
			info.appendChild(paused);
		}

		wrapper.appendChild(info);
		return wrapper;
	},
});
