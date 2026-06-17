Module.register("MMM-MusicDisplay", {
	defaults: {
		metadataPipe: "/tmp/shairport-sync-metadata",
		showProgress: true,
		showAlbumArt: true,
		artSize: 144,
		rotationSpeed: 8000,
		favorites: [],
	},

	start: function () {
		this.metadata = {};
		this.albumArt = null;
		this.progress = null;
		this.playing = false;
		this.lastUpdate = 0;
		this.recentTracks = [];
		this.carouselAngle = 0;
		this.carouselRing = null;
		this.carouselCards = [];
		this.carouselInfo = null;
		this.carouselFrontIndex = -1;
		this.dragging = false;
		this.dragVelocity = 0;
		this.dragIdleTime = 0;
		this._updateTimer = null;
		this._marqueeTimer = null;
		this.hasRealProgress = false;
		this.sendSocketNotification("CONFIG", this.config);

		setInterval(() => {
			if (this.playing && this.progress && this.hasRealProgress) {
				this.progress.current += 44100;
				this.tickProgress();
			}
		}, 1000);

		setInterval(() => {
			if (this.playing || this.recentTracks.length <= 1) return;

			if (!this.carouselRing) {
				this.bindCarousel();
				if (!this.carouselRing) return;
			}

			if (this.dragging) return;

			if (Math.abs(this.dragVelocity) > 0.05) {
				this.carouselAngle = (this.carouselAngle + this.dragVelocity + 360) % 360;
				this.dragVelocity *= 0.95;
				this.updateCarousel();
			} else {
				this.dragVelocity = 0;
				this.dragIdleTime += 50;
				if (this.dragIdleTime > 3000) {
					const n = this.recentTracks.length;
					this.carouselAngle = (this.carouselAngle + 18000 / (this.config.rotationSpeed * n)) % 360;
					this.updateCarousel();
				}
			}
		}, 50);
	},

	getStyles: function () {
		return ["MMM-MusicDisplay.css"];
	},

	getTemplate: function () {
		return "MMM-MusicDisplay.njk";
	},

	getTemplateData: function () {
		const hasMetadata = this.metadata && Object.keys(this.metadata).length > 0;
		const stale = Date.now() - this.lastUpdate > 120000;
		const isLive = this.playing || (hasMetadata && !stale);

		let mode = "hidden";
		if (isLive) {
			mode = "live";
		} else if (this.recentTracks.length > 0) {
			mode = "carousel";
		}

		const n = this.recentTracks.length;
		const angleStep = n > 0 ? 360 / n : 0;

		return {
			mode: mode,
			metadata: this.metadata,
			albumArt: this.albumArt,
			artSize: this.config.artSize,
			showAlbumArt: this.config.showAlbumArt,
			showProgress: this.config.showProgress,
			hasProgress: !!this.progress,
			playing: this.playing,
			radius: 250,
			tracks: this.recentTracks.map(function (t, i) {
				return {
					image: t.image || "",
					album: t.album || "",
					artist: t.artist || "",
					angle: i * angleStep,
				};
			}),
		};
	},

	bindCarousel: function () {
		const wrapper = document.querySelector(".MMM-MusicDisplay");
		if (!wrapper) return;
		const ring = wrapper.querySelector(".carousel-ring");
		if (!ring) return;

		this.carouselRing = ring;
		this.carouselCards = [];
		wrapper.querySelectorAll(".carousel-card").forEach((el) => {
			this.carouselCards.push({
				el: el,
				baseAngle: parseFloat(el.dataset.angle),
			});
		});
		this.carouselInfo = wrapper.querySelector(".carousel-info");
		this.carouselFrontIndex = -1;
		this.updateCarousel();
		this.attachDragListeners(wrapper.querySelector(".carousel-scene"));
	},

	bindMarquees: function () {
		const wrapper = document.querySelector(".MMM-MusicDisplay");
		if (!wrapper) return;
		wrapper.querySelectorAll(".marquee-content").forEach((inner) => {
			if (inner.dataset.bound) return;
			inner.dataset.bound = "1";
			const outer = inner.parentElement;
			if (inner.scrollWidth > outer.clientWidth) {
				const text = inner.textContent;
				const gap = "        ";
				inner.textContent = text + gap + text + gap;
				inner.classList.add("marquee-scroll");
				inner.style.animationDuration = Math.max(inner.scrollWidth / 2 / 30, 5) + "s";
			}
		});
	},

	tickProgress: function () {
		if (!this.progress) return;
		const wrapper = document.querySelector(".MMM-MusicDisplay");
		if (!wrapper) return;
		const bar = wrapper.querySelector(".music-progress");
		const label = wrapper.querySelector(".music-time");
		if (!bar || !label) return;
		const start = this.progress.start / 44100;
		const current = this.progress.current / 44100;
		const end = this.progress.end / 44100;
		let elapsed = current - start;
		const duration = end - start;
		if (elapsed > duration) elapsed = duration;
		if (elapsed < 0) elapsed = 0;

		bar.value = elapsed;
		bar.max = duration;
		label.textContent = this.secToTime(elapsed) + " / " + this.secToTime(duration);
	},

	scheduleUpdate: function () {
		if (this._marqueeTimer) clearTimeout(this._marqueeTimer);
		if (this._updateTimer) clearTimeout(this._updateTimer);
		this._updateTimer = setTimeout(() => {
			this._updateTimer = null;
			this.resetRefs();
			this.updateDom(500);
			this._marqueeTimer = setTimeout(() => this.bindMarquees(), 1000);
		}, 300);
	},

	resetRefs: function () {
		this.carouselRing = null;
		this.carouselCards = [];
		this.carouselInfo = null;
		this.carouselFrontIndex = -1;
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "RECENT_TRACKS") {
			this.recentTracks = payload;
			if (!this.playing) {
				this.scheduleUpdate();
			}
			return;
		}

		this.lastUpdate = Date.now();

		if (notification === "METADATA") {
			this.metadata = payload;
			this.playing = true;
			this.scheduleUpdate();
		} else if (notification === "IMAGE") {
			this.albumArt = payload || null;
			const wrapper = document.querySelector(".MMM-MusicDisplay");
			const img = wrapper && wrapper.querySelector(".music-art");
			if (img && this.albumArt) {
				img.src = this.albumArt;
			} else {
				this.scheduleUpdate();
			}
		} else if (notification === "PROGRESS") {
			const hadProgress = !!this.progress;
			const parts = payload.split("/");
			this.progress = {
				start: parseInt(parts[0]),
				current: parseInt(parts[1]),
				end: parseInt(parts[2]),
			};
			if (this.progress.start > 0) {
				this.hasRealProgress = true;
			}
			this.playing = true;
			if (!hadProgress) {
				this.scheduleUpdate();
			} else {
				this.tickProgress();
			}
		} else if (notification === "PAUSE") {
			this.playing = false;
			this.scheduleUpdate();
		} else if (notification === "RESUME") {
			this.playing = true;
			this.scheduleUpdate();
		} else if (notification === "STOP") {
			this.playing = false;
			this.metadata = {};
			this.albumArt = null;
			this.progress = null;
			this.hasRealProgress = false;
			this.scheduleUpdate();
		}
	},

	secToTime: function (sec) {
		const min = Math.floor(sec / 60);
		let remain = Math.floor(sec % 60);
		if (remain < 10) remain = "0" + remain;
		return min + ":" + remain;
	},

	attachDragListeners: function (scene) {
		if (!scene) return;
		let lastX = 0;
		let lastTime = 0;

		const onStart = (x) => {
			this.dragging = true;
			this.dragVelocity = 0;
			this.dragIdleTime = 0;
			lastX = x;
			lastTime = Date.now();
		};

		const onMove = (x) => {
			if (!this.dragging) return;
			const dx = x - lastX;
			const now = Date.now();
			const dt = Math.max(now - lastTime, 1);
			lastX = x;
			lastTime = now;
			const angleDelta = -dx * 0.3;
			this.carouselAngle = (this.carouselAngle + angleDelta + 360) % 360;
			const newVelocity = angleDelta / Math.max(dt / 50, 0.2);
			this.dragVelocity = this.dragVelocity * 0.5 + newVelocity * 0.5;
			this.updateCarousel();
		};

		const onEnd = () => {
			this.dragging = false;
			this.dragIdleTime = 0;
		};

		scene.addEventListener("mousedown", (e) => {
			onStart(e.clientX);
			e.preventDefault();
			const move = (ev) => onMove(ev.clientX);
			const up = () => {
				onEnd();
				document.removeEventListener("mousemove", move);
				document.removeEventListener("mouseup", up);
			};
			document.addEventListener("mousemove", move);
			document.addEventListener("mouseup", up);
		});

		scene.addEventListener("touchstart", (e) => {
			onStart(e.touches[0].clientX);
			const move = (ev) => {
				onMove(ev.touches[0].clientX);
				ev.preventDefault();
			};
			const end = () => {
				onEnd();
				document.removeEventListener("touchmove", move);
				document.removeEventListener("touchend", end);
			};
			document.addEventListener("touchmove", move, { passive: false });
			document.addEventListener("touchend", end);
		}, { passive: true });
	},

	updateCarousel: function () {
		if (!this.carouselRing) return;
		this.carouselRing.style.transform = "rotateY(" + this.carouselAngle + "deg)";

		let frontIndex = 0;
		let minAngle = 360;

		this.carouselCards.forEach((card, i) => {
			let effective = (card.baseAngle + this.carouselAngle) % 360;
			if (effective > 180) effective = 360 - effective;

			let opacity;
			if (effective <= 20) opacity = 1;
			else if (effective <= 60) opacity = 1 - (effective - 20) / 40;
			else opacity = 0;

			card.el.style.opacity = opacity;

			if (effective < minAngle) {
				minAngle = effective;
				frontIndex = i;
			}
		});

		if (frontIndex !== this.carouselFrontIndex && this.carouselInfo) {
			this.carouselFrontIndex = frontIndex;
			const track = this.recentTracks[frontIndex];
			if (track) {
				this.carouselInfo.innerHTML = "";
				if (track.album) {
					const albumEl = document.createElement("div");
					albumEl.className = "carousel-album bright small";
					albumEl.textContent = track.album;
					this.carouselInfo.appendChild(albumEl);
				}
				if (track.artist) {
					const artistEl = document.createElement("div");
					artistEl.className = "carousel-artist xsmall dimmed";
					artistEl.textContent = track.artist;
					this.carouselInfo.appendChild(artistEl);
				}
			}
		}
	},
});
