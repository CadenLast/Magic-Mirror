Module.register("MMM-HourlyWeather", {
	defaults: {
		hoursToShow: 12,
		timeFormat: 12,
		units: "imperial"
	},

	getStyles () {
		return [this.file("MMM-HourlyWeather.css"), "weather-icons.css"];
	},

	getScripts () {
		return ["moment.js"];
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.hourlyData = [];
		this.sunrise = null;
		this.sunset = null;
	},

	notificationReceived (notification, payload) {
		if (notification === "WEATHER_UPDATED" && payload.hourlyArray && payload.hourlyArray.length > 0) {
			this.hourlyData = payload.hourlyArray;
			const first = payload.hourlyArray[0];
			if (first.sunrise) this.sunrise = first.sunrise;
			if (first.sunset) this.sunset = first.sunset;
			this.updateDom();
		}
	},

	windDirection (degrees) {
		if (degrees == null) return "";
		const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
		return dirs[Math.round(degrees / 22.5) % 16];
	},

	getTemplate () {
		return "MMM-HourlyWeather.njk";
	},

	formatHour (h) {
		const m = moment(h.date);
		const time = this.config.timeFormat === 24 ? m.format("HH:mm") : m.format("h a");
		return {
			time,
			icon: h.weatherType,
			temp: h.temperature != null ? Math.round(h.temperature) : null,
			feelsLike: h.feelsLikeTemp != null ? Math.round(h.feelsLikeTemp) : null,
			uv: h.uvIndex != null ? Math.round(h.uvIndex) : null,
			precipChance: h.precipitationProbability != null ? Math.round(h.precipitationProbability) : null,
			humidity: h.humidity != null ? Math.round(h.humidity) : null,
			wind: h.windSpeed != null ? Math.round(h.windSpeed) : null,
			windDir: this.windDirection(h.windFromDirection)
		};
	},

	getTemplateData () {
		const now = moment();

		let current = null;
		const closest = this.hourlyData
			.filter((h) => moment(h.date).isBefore(now))
			.pop();
		if (closest) {
			current = this.formatHour(closest);
		}

		const hours = this.hourlyData
			.filter((h) => moment(h.date).isAfter(now))
			.slice(0, this.config.hoursToShow)
			.map((h) => this.formatHour(h));

		const fmt = this.config.timeFormat === 24 ? "HH:mm" : "h:mm a";
		const sunrise = this.sunrise ? moment(this.sunrise).format(fmt) : null;
		const sunset = this.sunset ? moment(this.sunset).format(fmt) : null;

		return {
			loaded: hours.length > 0,
			current,
			hours,
			sunrise,
			sunset
		};
	}
});
