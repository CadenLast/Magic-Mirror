const NodeHelper = require("node_helper");
const Log = require("logger");
const CalendarFetcher = require("../../defaultmodules/calendar/calendarfetcher");

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.fetchers = [];
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "ADD_CALENDAR") {
			this.createFetcher(payload.url, payload.fetchInterval, payload.selfSignedCert);
		}
	},

	createFetcher (url, fetchInterval, selfSignedCert) {
		if (typeof this.fetchers[url] !== "undefined") {
			return;
		}

		Log.log(`[MMM-WeekCalendar] Creating fetcher for: ${url}`);
		const fetcher = new CalendarFetcher(
			url,
			fetchInterval,
			[],    // excludedEvents
			1000,  // maximumEntries
			365,   // maximumNumberOfDays
			{},    // auth
			true,  // includePastEvents
			selfSignedCert
		);

		fetcher.onReceive(() => {
			const allEvents = Object.values(this.fetchers).flatMap((f) => f.events);
			this.sendSocketNotification("CALENDAR_DATA", allEvents);
		});

		fetcher.onError((f, errorInfo) => {
			Log.error(`[MMM-WeekCalendar] Error fetching: ${url}`, errorInfo.message || errorInfo);
		});

		this.fetchers[url] = fetcher;
		fetcher.fetchCalendar();
	}
});
