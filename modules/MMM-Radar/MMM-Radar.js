Module.register("MMM-Radar", {
	defaults: {
		lat: 41.726788,
		lon: -93.604283,
		zoom: 7,
		width: "400px",
		height: "400px",
		animationSpeed: 600,
		lastFramePause: 2000,
		updateInterval: 5 * 60 * 1000,
		radarOpacity: 0.65
	},

	getStyles () {
		return [
			"https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
			"MMM-Radar.css"
		];
	},

	getScripts () {
		return ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
	},

	start () {
		this.map = null;
		this.radarLayers = [];
		this.frameTimes = [];
		this.currentFrame = 0;
		this.animationTimer = null;
		this.recenterTimer = null;
		this.wrapper = null;

		document.addEventListener("mm-activity", () => {
			if (this._resetTimer) clearTimeout(this._resetTimer);
			this._resetTimer = setTimeout(() => {
				if (this.map) {
					this.map.setView([this.config.lat, this.config.lon], this.config.zoom, { animate: true });
				}
			}, config.resetTimeout);
		});
	},

	getDom () {
		if (!this.wrapper) {
			this.wrapper = document.createElement("div");
			this.wrapper.className = "mmm-radar-container";

			this.mapEl = document.createElement("div");
			this.mapEl.className = "mmm-radar-map";
			this.mapEl.style.width = this.config.width;
			this.mapEl.style.height = this.config.height;
			this.wrapper.appendChild(this.mapEl);

			this.timestampEl = document.createElement("div");
			this.timestampEl.className = "mmm-radar-timestamp";
			this.wrapper.appendChild(this.timestampEl);

			setTimeout(() => this.initMap(), 200);
		}
		return this.wrapper;
	},

	initMap () {
		if (this.map) return;

		this.map = L.map(this.mapEl, {
			zoomControl: false,
			attributionControl: false,
			dragging: false,
			scrollWheelZoom: true,
			doubleClickZoom: false,
			boxZoom: false,
			keyboard: false,
			touchZoom: true,
			zoomSnap: 0.5
		}).setView([this.config.lat, this.config.lon], this.config.zoom);


		L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png").addTo(this.map);

		this.map.on("zoomend moveend", () => document.dispatchEvent(new Event("mm-activity")));

		this.addCities();
		this.fetchRadarData();
		setInterval(() => this.fetchRadarData(), this.config.updateInterval);
	},


	addCities () {
		const cities = [
			{ name: "Ankeny", lat: 41.7318, lon: -93.6001 },
			{ name: "Des Moines", lat: 41.5868, lon: -93.6250 },
			{ name: "Cedar Rapids", lat: 41.9779, lon: -91.6656 },
			{ name: "Clear Lake", lat: 43.1436, lon: -93.3788 },
			{ name: "Davenport", lat: 41.5236, lon: -90.5776 },
			{ name: "Iowa City", lat: 41.6611, lon: -91.5302 },
			{ name: "Sioux City", lat: 42.4963, lon: -96.4049 },
			{ name: "Waterloo", lat: 42.4928, lon: -92.3426 },
			{ name: "Omaha", lat: 41.2565, lon: -95.9345 },
			{ name: "Kansas City", lat: 39.0997, lon: -94.5786 },
			{ name: "Minneapolis", lat: 44.9778, lon: -93.2650 }
		];

		cities.forEach((city) => {
			L.circleMarker([city.lat, city.lon], {
				radius: 2,
				color: "#fff",
				fillColor: "#fff",
				fillOpacity: 0.8,
				weight: 0
			}).addTo(this.map)
				.bindTooltip(city.name, {
					permanent: true,
					direction: "right",
					className: "mmm-radar-city-label",
					offset: [4, 0]
				});
		});
	},

	fetchRadarData () {
		if (!this.map) return;

		fetch("https://api.rainviewer.com/public/weather-maps.json")
			.then((res) => res.json())
			.then((data) => {
				this.radarLayers.forEach((layer) => this.map.removeLayer(layer));
				this.radarLayers = [];
				this.frameTimes = [];

				const frames = [...data.radar.past, ...(data.radar.nowcast || [])];

				frames.forEach((frame) => {
					const layer = L.tileLayer(
						`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
						{ opacity: 0 }
					);
					layer.addTo(this.map);
					this.radarLayers.push(layer);
					this.frameTimes.push(frame.time * 1000);
				});

				this.currentFrame = 0;
				this.startAnimation();
			})
			.catch((err) => Log.error("MMM-Radar:", err));
	},

	startAnimation () {
		if (this.animationTimer) clearTimeout(this.animationTimer);
		if (this.radarLayers.length === 0) return;

		this.showFrame(0);
		this.scheduleNext();
	},

	scheduleNext () {
		const isLastFrame = this.currentFrame === this.radarLayers.length - 1;
		const delay = isLastFrame ? this.config.lastFramePause : this.config.animationSpeed;

		this.animationTimer = setTimeout(() => {
			this.currentFrame = (this.currentFrame + 1) % this.radarLayers.length;
			this.showFrame(this.currentFrame);
			this.scheduleNext();
		}, delay);
	},

	showFrame (index) {
		this.radarLayers.forEach((layer, i) => {
			layer.setOpacity(i === index ? this.config.radarOpacity : 0);
		});

		if (this.frameTimes[index]) {
			const date = new Date(this.frameTimes[index]);
			const hours = date.getHours();
			const minutes = date.getMinutes().toString().padStart(2, "0");
			const period = hours >= 12 ? "PM" : "AM";
			const h = hours % 12 || 12;
			this.timestampEl.textContent = `${h}:${minutes} ${period}`;
		}
	}
});
