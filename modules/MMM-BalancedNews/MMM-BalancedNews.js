Module.register("MMM-BalancedNews", {
	defaults: {
		feeds: [],
		maxPerFeed: 5,
		showAsList: false,
		showSourceTitle: true,
		showPublishDate: true,
		broadcastNewsFeeds: true,
		broadcastNewsUpdates: true,
		showDescription: false,
		showTitleAsUrl: false,
		wrapTitle: true,
		wrapDescription: true,
		truncDescription: true,
		lengthDescription: 400,
		hideLoading: false,
		reloadInterval: 5 * 60 * 1000,
		updateInterval: 10 * 1000,
		animationSpeed: 2.5 * 1000,
		maxNewsItems: 0,
		ignoreOldItems: false,
		ignoreOlderThan: 24 * 60 * 60 * 1000,
		removeStartTags: "",
		removeEndTags: "",
		startTags: [],
		endTags: [],
		scrollLength: 500,
		logFeedWarnings: false,
		dangerouslyDisableAutoEscaping: false
	},

	getUrlPrefix (item) {
		if (item.useCorsProxy) {
			return `${location.protocol}//${location.host}${config.basePath}cors?url=`;
		}
		return "";
	},

	getScripts () {
		return ["moment.js"];
	},

	getStyles () {
		return ["newsfeed.css", this.file("MMM-BalancedNews.css")];
	},

	getTranslations () {
		return false;
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		moment.locale(config.language);
		this.newsItems = [];
		this.loaded = false;
		this.error = null;
		this.activeItem = 0;
		this.scrollPosition = 0;
		this.isShowingDescription = this.config.showDescription;
		this.popupOverlay = null;
		this.registerFeeds();

		document.addEventListener("mm-activity", () => {
			if (this._resetTimer) clearTimeout(this._resetTimer);
			this._resetTimer = setTimeout(() => {
				this.activeItem = 0;
				this.updateDom(this.config.animationSpeed);
			}, config.resetTimeout);
		});
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "NEWS_ITEMS") {
			this.generateFeed(payload);
			if (!this.loaded) {
				if (this.config.hideLoading) {
					this.show();
				}
				this.scheduleUpdateInterval();
			}
			this.loaded = true;
			this.error = null;
		} else if (notification === "NEWSFEED_ERROR") {
			this.error = this.translate(payload.error_type);
			this.scheduleUpdateInterval();
		}
	},

	getTemplate () {
		return "MMM-BalancedNews.njk";
	},

	getDom () {
		return this._super().then((dom) => {
			dom.style.width = "100%";
			const prev = dom.querySelector(".balanced-news-prev");
			const next = dom.querySelector(".balanced-news-next");
			if (prev) {
				prev.addEventListener("click", () => {
					this.activeItem--;
					if (this.activeItem < 0) {
						this.activeItem = this.newsItems.length - 1;
					}
					this.resetTimer();
					this.broadcastInteraction();
					this.updateDom(this.config.animationSpeed);
				});
			}
			if (next) {
				next.addEventListener("click", () => {
					this.activeItem++;
					if (this.activeItem >= this.newsItems.length) {
						this.activeItem = 0;
					}
					this.resetTimer();
					this.broadcastInteraction();
					this.updateDom(this.config.animationSpeed);
				});
			}
			const content = dom.querySelector(".balanced-news-content");
			if (content) {
				content.addEventListener("click", () => {
					this.showPopup(this.activeItem);
				});
			}
			const listItems = dom.querySelectorAll(".newsfeed-list li");
			listItems.forEach((li, i) => {
				li.addEventListener("click", () => {
					this.showPopup(i);
				});
			});
			return dom;
		});
	},

	broadcastInteraction () {
		document.dispatchEvent(new Event("mm-activity"));
	},

	resetTimer () {
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => {
			if (this.newsItems.length > 1 || this.newsItems.length !== this.activeItemCount || this.activeItemHash !== this.newsItems[0]?.hash) {
				this.activeItem++;
				this.updateDom(this.config.animationSpeed);
			}
			if (this.config.broadcastNewsFeeds) {
				this.sendNotification("NEWS_FEED", { items: this.newsItems });
			}
		}, this.config.updateInterval);
	},

	getTemplateData () {
		if (this.activeItem >= this.newsItems.length) {
			this.activeItem = 0;
		}
		this.activeItemCount = this.newsItems.length;
		if (this.error) {
			this.activeItemHash = undefined;
			return { error: this.error };
		}
		if (this.newsItems.length === 0) {
			this.activeItemHash = undefined;
			return { empty: true };
		}
		const item = this.newsItems[this.activeItem];
		this.activeItemHash = item.hash;
		const items = this.newsItems.map(function (item) {
			item.publishDate = moment(new Date(item.pubdate)).fromNow();
			return item;
		});
		return {
			loaded: true,
			config: this.config,
			sourceTitle: item.sourceTitle,
			publishDate: moment(new Date(item.pubdate)).fromNow(),
			title: item.title,
			url: this.getActiveItemURL(),
			description: item.description,
			items: items
		};
	},

	getActiveItemURL () {
		const item = this.newsItems[this.activeItem];
		if (item) {
			return typeof item.url === "string" ? this.getUrlPrefix(item) + item.url : this.getUrlPrefix(item) + item.url.href;
		}
		return "";
	},

	registerFeeds () {
		for (let feed of this.config.feeds) {
			this.sendSocketNotification("ADD_FEED", {
				feed: feed,
				config: this.config
			});
		}
	},

	getFeedProperty (feed, property) {
		let res = this.config[property];
		const f = this.config.feeds.find((feedItem) => feedItem.url === feed);
		if (f && f[property]) res = f[property];
		return res;
	},

	generateFeed (feeds) {
		const maxPerFeed = this.config.maxPerFeed || 0;
		const feedBuckets = [];

		for (let feed in feeds) {
			const feedItems = feeds[feed];
			if (this.subscribedToFeed(feed)) {
				let items = [];
				for (let item of feedItems) {
					item.sourceTitle = this.titleForFeed(feed);
					if (!(this.getFeedProperty(feed, "ignoreOldItems") && Date.now() - new Date(item.pubdate) > this.getFeedProperty(feed, "ignoreOlderThan"))) {
						items.push(item);
					}
				}
				items.sort((a, b) => new Date(b.pubdate) - new Date(a.pubdate));
				if (maxPerFeed > 0) {
					items = items.slice(0, maxPerFeed);
				}
				if (items.length > 0) {
					feedBuckets.push(items);
				}
			}
		}

		let newsItems = [];
		const maxLen = Math.max(...feedBuckets.map(b => b.length), 0);
		for (let i = 0; i < maxLen; i++) {
			for (let bucket of feedBuckets) {
				if (i < bucket.length) {
					newsItems.push(bucket[i]);
				}
			}
		}

		if (this.config.maxNewsItems > 0) {
			newsItems = newsItems.slice(0, this.config.maxNewsItems);
		}

		newsItems.forEach((item) => {
			if (this.config.removeStartTags === "title" || this.config.removeStartTags === "both") {
				for (let startTag of this.config.startTags) {
					if (item.title.slice(0, startTag.length) === startTag) {
						item.title = item.title.slice(startTag.length, item.title.length);
					}
				}
			}
			if (this.config.removeStartTags === "description" || this.config.removeStartTags === "both") {
				if (this.isShowingDescription) {
					for (let startTag of this.config.startTags) {
						if (item.description.slice(0, startTag.length) === startTag) {
							item.description = item.description.slice(startTag.length, item.description.length);
						}
					}
				}
			}
			if (this.config.removeEndTags) {
				for (let endTag of this.config.endTags) {
					if (item.title.slice(-endTag.length) === endTag) {
						item.title = item.title.slice(0, -endTag.length);
					}
				}
				if (this.isShowingDescription) {
					for (let endTag of this.config.endTags) {
						if (item.description.slice(-endTag.length) === endTag) {
							item.description = item.description.slice(0, -endTag.length);
						}
					}
				}
			}
		});

		const updatedItems = [];
		newsItems.forEach((value) => {
			if (this.newsItems.findIndex((value1) => value1 === value) === -1) {
				updatedItems.push(value);
			}
		});

		if (this.config.broadcastNewsUpdates && updatedItems.length > 0) {
			this.sendNotification("NEWS_FEED_UPDATE", { items: updatedItems });
		}

		this.newsItems = newsItems;
	},

	subscribedToFeed (feedUrl) {
		for (let feed of this.config.feeds) {
			if (feed.url === feedUrl) {
				return true;
			}
		}
		return false;
	},

	titleForFeed (feedUrl) {
		for (let feed of this.config.feeds) {
			if (feed.url === feedUrl) {
				return feed.title || "";
			}
		}
		return "";
	},

	scheduleUpdateInterval () {
		this.updateDom(this.config.animationSpeed);
		if (this.config.broadcastNewsFeeds) {
			this.sendNotification("NEWS_FEED", { items: this.newsItems });
		}
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => {
			if (this.newsItems.length > 1 || this.newsItems.length !== this.activeItemCount || this.activeItemHash !== this.newsItems[0]?.hash) {
				this.activeItem++;
				this.updateDom(this.config.animationSpeed);
			}
			if (this.config.broadcastNewsFeeds) {
				this.sendNotification("NEWS_FEED", { items: this.newsItems });
			}
		}, this.config.updateInterval);
	},

	showPopup (index) {
		const item = this.newsItems[index];
		if (!item || !item.url) return;

		const url = typeof item.url === "string" ? item.url : item.url.href;

		this.closePopup();

		const overlay = document.createElement("div");
		overlay.className = "balanced-news-popup-overlay";

		const header = document.createElement("div");
		header.className = "balanced-news-popup-header";

		const title = document.createElement("span");
		title.className = "balanced-news-popup-title";
		title.textContent = item.title;

		const closeBtn = document.createElement("span");
		closeBtn.className = "balanced-news-popup-close";
		closeBtn.innerHTML = "&times;";
		closeBtn.addEventListener("click", () => this.closePopup());

		header.appendChild(title);
		header.appendChild(closeBtn);

		const iframe = document.createElement("iframe");
		iframe.className = "balanced-news-popup-iframe";
		iframe.src = url;

		overlay.appendChild(header);
		overlay.appendChild(iframe);

		document.body.appendChild(overlay);
		this.popupOverlay = overlay;

		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	},

	closePopup () {
		if (this.popupOverlay) {
			this.popupOverlay.remove();
			this.popupOverlay = null;
		}
		if (!this.timer) {
			this.scheduleUpdateInterval();
		}
	},

	notificationReceived (notification) {
		if (notification === "MODULE_DOM_CREATED" && this.config.hideLoading) {
			this.hide();
		} else if (notification === "MODULE_DOM_UPDATED") {
			if (this._scrollAnim) cancelAnimationFrame(this._scrollAnim);
			const wrapper = document.getElementById(this.identifier);
			if (!wrapper) return;
			const title = wrapper.querySelector(".newsfeed-title");
			if (!title) return;
			title.style.transform = "";
			const content = wrapper.querySelector(".balanced-news-content");
			if (!content) return;
			const overflow = title.scrollWidth - content.clientWidth;
			if (overflow > 1) {
				const speed = Math.max(20, overflow * 0.15);
				const duration = overflow / speed * 1000;
				const startTime = performance.now();
				const startDelay = 500;
				const self = this;
				(function step (now) {
					const elapsed = now - startTime - startDelay;
					if (elapsed < 0) {
						self._scrollAnim = requestAnimationFrame(step);
						return;
					}
					const progress = Math.min(elapsed / duration, 1);
					title.style.transform = `translateX(${-overflow * progress}px)`;
					if (progress < 1) {
						self._scrollAnim = requestAnimationFrame(step);
					}
				})(performance.now());
			}
		} else if (notification === "ARTICLE_NEXT") {
			this.activeItem++;
			if (this.activeItem >= this.newsItems.length) {
				this.activeItem = 0;
			}
			this.isShowingDescription = this.config.showDescription;
			this.updateDom(100);
		} else if (notification === "ARTICLE_PREVIOUS") {
			this.activeItem--;
			if (this.activeItem < 0) {
				this.activeItem = this.newsItems.length - 1;
			}
			this.isShowingDescription = this.config.showDescription;
			this.updateDom(100);
		}
	}
});
