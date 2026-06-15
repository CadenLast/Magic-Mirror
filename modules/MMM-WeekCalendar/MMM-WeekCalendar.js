Module.register("MMM-WeekCalendar", {
	defaults: {
		calendars: [],
		daysToShow: 7,
		startOnMonday: false,
		timeFormat: 12,
		fetchInterval: 60 * 60 * 1000,
		updateInterval: 60 * 1000
	},

	getStyles () {
		return [this.file("MMM-WeekCalendar.css"), "font-awesome.css", "weather-icons.css"];
	},

	getScripts () {
		return ["moment.js"];
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.calendarEvents = [];
		this.forecastData = [];
		this.weekOffset = 0;
		for (const cal of this.config.calendars) {
			this.sendSocketNotification("ADD_CALENDAR", {
				url: cal.url,
				fetchInterval: this.config.fetchInterval,
				selfSignedCert: cal.selfSignedCert || false
			});
		}
		setInterval(() => this.updateDom(), this.config.updateInterval);

		document.addEventListener("mm-activity", () => {
			if (this._resetTimer) clearTimeout(this._resetTimer);
			this._resetTimer = setTimeout(() => {
				this.weekOffset = 0;
				this.updateDom().then(() => {
					const wrapper = document.getElementById(this.identifier);
					if (!wrapper) return;
					wrapper.querySelectorAll(".week-day-events").forEach((el) => {
						el.scrollTop = 0;
					});
				});
			}, config.resetTimeout);
		});
	},

	notificationReceived (notification, payload) {
		if (notification === "WEATHER_UPDATED" && payload.forecastArray && payload.forecastArray.length > 0) {
			this.forecastData = payload.forecastArray;
			this.updateDom();
		}
	},

	broadcastInteraction () {
		document.dispatchEvent(new Event("mm-activity"));
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CALENDAR_DATA") {
			this.calendarEvents = payload;
			this.updateDom();
		}
	},

	getWeekDays () {
		const today = moment().startOf("day");
		const startOfWeek = today.clone().startOf("week");
		if (this.config.startOnMonday) {
			startOfWeek.isoWeekday(1);
		}
		startOfWeek.add(this.weekOffset * 7, "days");
		const days = [];
		for (let i = 0; i < this.config.daysToShow; i++) {
			days.push(startOfWeek.clone().add(i, "days"));
		}
		return days;
	},

	getEventsForDay (dayMoment) {
		const dayStart = dayMoment.valueOf();
		const dayEnd = dayMoment.clone().endOf("day").valueOf();
		return this.calendarEvents.filter((event) => {
			const eventStart = parseInt(event.startDate);
			const eventEnd = parseInt(event.endDate) || eventStart;
			return eventStart < dayEnd && eventEnd > dayStart;
		});
	},

	getForecastForDay (dayMoment) {
		return this.forecastData.find((f) => {
			if (!f.date) return false;
			return moment(f.date).isSame(dayMoment, "day");
		});
	},

	formatTime (timestamp) {
		const m = moment(parseInt(timestamp));
		if (this.config.timeFormat === 24) {
			return m.format("HH:mm");
		}
		return m.format("h:mm a");
	},

	getTemplate () {
		return "MMM-WeekCalendar.njk";
	},

	getDom () {
		return this._super().then((dom) => {
			const prev = dom.querySelector(".week-nav-prev");
			const next = dom.querySelector(".week-nav-next");
			if (prev) {
				prev.addEventListener("click", () => {
					this.weekOffset--;
					this.broadcastInteraction();
					this.updateDom();
				});
			}
			if (next) {
				next.addEventListener("click", () => {
					this.weekOffset++;
					this.broadcastInteraction();
					this.updateDom();
				});
			}
			dom.querySelectorAll(".week-day-events").forEach((el) => {
				const indicator = el.parentElement.querySelector(".week-scroll-indicator");
				if (!indicator) return;
				const updateIndicator = () => {
					const canScroll = el.scrollHeight > el.clientHeight;
					const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
					indicator.classList.toggle("visible", canScroll && !atBottom);
				};
				el.addEventListener("scroll", () => {
					updateIndicator();
					this.broadcastInteraction();
				});
				setTimeout(updateIndicator, 50);
			});
			return dom;
		});
	},

	getTemplateData () {
		const days = this.getWeekDays();
		const today = moment().startOf("day");

		return {
			loaded: this.calendarEvents.length > 0 || this.forecastData.length > 0,
			weekOffset: this.weekOffset,
			days: days.map((day) => {
				const forecast = this.getForecastForDay(day);
				return {
					name: day.format("ddd"),
					date: day.format("M/D"),
					isToday: day.isSame(today, "day"),
					weather: forecast ? {
						icon: forecast.weatherType,
						high: forecast.maxTemperature != null ? Math.round(forecast.maxTemperature) : null,
						low: forecast.minTemperature != null ? Math.round(forecast.minTemperature) : null,
						isPast: day.isBefore(today, "day"),
						precipAmount: forecast.precipitationAmount != null ? parseFloat(forecast.precipitationAmount.toFixed(2)) : null,
						precipChance: forecast.precipitationProbability != null ? Math.round(forecast.precipitationProbability) : null
					} : null,
					events: this.getEventsForDay(day).map((event) => ({
						title: event.title,
						color: event.color || null,
						fullDay: event.fullDayEvent,
						time: event.fullDayEvent ? null : this.formatTime(event.startDate)
					})).sort((a, b) => {
						if (a.fullDay && !b.fullDay) return -1;
						if (!a.fullDay && b.fullDay) return 1;
						return 0;
					})
				};
			})
		};
	},

});
