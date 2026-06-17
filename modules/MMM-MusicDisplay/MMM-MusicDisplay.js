Module.register("MMM-MusicDisplay", {
	defaults: {
		metadataPipe: "/tmp/shairport-sync-metadata",
		showProgress: true,
		showAlbumArt: true,
		artSize: 144,
		shortcutPort: 8181,
		rotationSpeed: 8000,
	},

	start: function () {
		this.metadata = {};
		this.albumArt = null;
		this.progress = null;
		this.playing = false;
		this.lastUpdate = 0;
		this.progressBar = null;
		this.progressLabel = null;
		this.recentTracks = [];
		this.currentTrackIndex = 0;
		this.sendSocketNotification("CONFIG", this.config);

		setInterval(() => {
			if (this.playing && this.progress) {
				this.progress.current += 44100;
				this.tickProgress();
			}
		}, 1000);

		setInterval(() => {
			if (!this.playing && this.recentTracks.length > 1) {
				this.rotateToNext();
			}
		}, this.config.rotationSpeed);
	},

	getStyles: function () {
		return ["MMM-MusicDisplay.css"];
	},

	tickProgress: function () {
		if (!this.progressBar || !this.progressLabel || !this.progress) return;
		const start = this.progress.start / 44100;
		const current = this.progress.current / 44100;
		const end = this.progress.end / 44100;
		let elapsed = current - start;
		const duration = end - start;
		if (elapsed > duration) elapsed = duration;
		if (elapsed < 0) elapsed = 0;

		this.progressBar.value = elapsed;
		this.progressBar.max = duration;
		this.progressLabel.textContent = this.secToTime(elapsed) + " / " + this.secToTime(duration);
	},

	rotateToNext: function () {
		const card = document.querySelector(".music-recent-card");
		if (!card || card.classList.contains("rack-out") || card.classList.contains("rack-in")) return;

		card.classList.add("rack-out");
		card.addEventListener(
			"animationend",
			() => {
				card.classList.remove("rack-out");
				this.currentTrackIndex = (this.currentTrackIndex + 1) % this.recentTracks.length;

				while (card.firstChild) card.removeChild(card.firstChild);
				this.populateCard(card, this.recentTracks[this.currentTrackIndex]);

				card.classList.add("rack-in");
				card.addEventListener(
					"animationend",
					() => {
						card.classList.remove("rack-in");
					},
					{ once: true }
				);
			},
			{ once: true }
		);
	},

	populateCard: function (card, track) {
		const top = document.createElement("div");
		top.className = "music-top";

		if (track.image) {
			const img = document.createElement("img");
			img.className = "music-art";
			img.src = track.image;
			img.width = this.config.artSize;
			img.height = this.config.artSize;
			top.appendChild(img);
		}

		const info = document.createElement("div");
		info.className = "music-info";

		if (track.title) {
			info.appendChild(this.makeMarquee(track.title, "music-title bright medium"));
		}
		if (track.artist) {
			info.appendChild(this.makeMarquee(track.artist, "music-artist small dimmed"));
		}
		if (track.album) {
			info.appendChild(this.makeMarquee(track.album, "music-album small dimmed"));
		}

		top.appendChild(info);
		card.appendChild(top);
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "RECENT_TRACKS") {
			this.recentTracks = payload;
			this.currentTrackIndex = 0;
			if (!this.playing) {
				this.updateDom(500);
			}
			return;
		}

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
			this.tickProgress();
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
			this.currentTrackIndex = 0;
			this.updateDom(500);
		}
	},

	makeMarquee: function (text, className) {
		const outer = document.createElement("div");
		outer.className = "marquee-container " + className;

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

		if (this.playing || (hasMetadata && !stale)) {
			this.data.header = "Now Playing";
			return this.buildLiveView(wrapper);
		}

		if (this.recentTracks.length > 0) {
			this.data.header = "Recently Played";
			return this.buildRecentView(wrapper);
		}

		wrapper.classList.add("hidden");
		return wrapper;
	},

	buildLiveView: function (wrapper) {
		const top = document.createElement("div");
		top.className = "music-top";

		if (this.config.showAlbumArt && this.albumArt) {
			const img = document.createElement("img");
			img.className = "music-art";
			img.src = this.albumArt;
			img.width = this.config.artSize;
			img.height = this.config.artSize;
			top.appendChild(img);
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

		if (!this.playing) {
			const paused = document.createElement("div");
			paused.className = "music-paused xsmall dimmed";
			paused.textContent = "Paused";
			info.appendChild(paused);
		}

		top.appendChild(info);
		wrapper.appendChild(top);

		if (this.config.showProgress && this.progress) {
			const bottom = document.createElement("div");
			bottom.className = "music-bottom";

			const bar = document.createElement("progress");
			bar.className = "music-progress";
			this.progressBar = bar;
			bottom.appendChild(bar);

			const time = document.createElement("div");
			time.className = "music-time xsmall dimmed";
			this.progressLabel = time;
			bottom.appendChild(time);

			this.tickProgress();
			wrapper.appendChild(bottom);
		} else {
			this.progressBar = null;
			this.progressLabel = null;
		}

		return wrapper;
	},

	buildRecentView: function (wrapper) {
		const container = document.createElement("div");
		container.className = "music-recent-container";

		const card = document.createElement("div");
		card.className = "music-recent-card";
		this.populateCard(card, this.recentTracks[this.currentTrackIndex]);

		container.appendChild(card);
		wrapper.appendChild(container);
		return wrapper;
	},
});
