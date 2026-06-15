const NodeHelper = require("node_helper");
const Log = require("logger");
const NewsfeedFetcher = require("../../defaultmodules/newsfeed/newsfeedfetcher");

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.fetchers = [];
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "ADD_FEED") {
			this.createFetcher(payload.feed, payload.config);
		}
	},

	createFetcher (feed, config) {
		const url = feed.url || "";
		const encoding = feed.encoding || "UTF-8";
		const reloadInterval = feed.reloadInterval || config.reloadInterval || 5 * 60 * 1000;
		const useCorsProxy = feed.useCorsProxy ?? true;

		try {
			new URL(url);
		} catch (error) {
			Log.error("Error: Malformed newsfeed url: ", url, error);
			this.sendSocketNotification("NEWSFEED_ERROR", { error_type: "MODULE_ERROR_MALFORMED_URL" });
			return;
		}

		let fetcher;
		if (typeof this.fetchers[url] === "undefined") {
			Log.log(`Create new newsfetcher for url: ${url} - Interval: ${reloadInterval}`);
			fetcher = new NewsfeedFetcher(url, reloadInterval, encoding, config.logFeedWarnings, useCorsProxy);

			fetcher.onReceive(() => {
				this.broadcastFeeds();
			});

			fetcher.onError((fetcher, errorInfo) => {
				Log.error("Error: Could not fetch newsfeed: ", fetcher.url, errorInfo.message || errorInfo);
				this.sendSocketNotification("NEWSFEED_ERROR", {
					error_type: errorInfo.translationKey
				});
			});

			this.fetchers[url] = fetcher;
		} else {
			Log.log(`Use existing newsfetcher for url: ${url}`);
			fetcher = this.fetchers[url];
			fetcher.setReloadInterval(reloadInterval);
			fetcher.broadcastItems();
		}

		fetcher.startFetch();
	},

	broadcastFeeds () {
		const feeds = {};
		for (const url in this.fetchers) {
			feeds[url] = this.fetchers[url].items;
		}
		this.sendSocketNotification("NEWS_ITEMS", feeds);
	}
});
