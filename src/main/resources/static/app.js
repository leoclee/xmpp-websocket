var stompClient = null;
var myJid = null; // only set after successful login
var jidToTimeout = {};

function setConnected(connected) {
}

function setLoggedIn(loggedOn) {
	if (loggedOn) {
		myJid = document.getElementById("inputEmail").value.trim().toLowerCase();

		document.getElementById("sidebar").classList.remove("invisible");
		document.getElementById("form-signin").classList.add("d-none");
		document.getElementById("form-logout").classList.remove("d-none");
		document.getElementById("loggedInJid").innerText = myJid;
	} else {
		myJid = null;

		document.getElementById("sidebar").classList.add("invisible");
		document.getElementById("form-signin").classList.remove("d-none");
		document.getElementById("form-logout").classList.add("d-none");
		document.getElementById("loggedInJid").innerText = "";
		document.getElementById("form-signin").inputEmail.focus();

		// clear roster
		var roster = document.getElementById("roster");
		while (roster.firstChild) {
			roster.removeChild(roster.firstChild);
		}
		// clear chat windows
		var chatWindows = document.getElementById("chatWindows");
		while (chatWindows.firstChild) {
			chatWindows.removeChild(chatWindows.firstChild);
		}
	}
}

function connect() {
	stompClient = new StompJs.Client({
		brokerURL: (location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/websocket',
		// debug: function (str) {console.log(str);},
		// logRawCommunication: true
	});
	stompClient.onWebSocketClose = function(closeEvent) {
		console.log(closeEvent);
	};
	stompClient.onStompError = function (frame) {
		// Will be invoked in case of error encountered at Broker
		// Bad login/passcode typically will cause an error
		// Complaint brokers will set `message` header with a brief message.
		// Body may contain details.
		// Compliant brokers will terminate the connection after any error
		console.log('Broker reported error: ' + frame.headers['message']);
		console.log('Additional details: ' + frame.body);
	};
	stompClient.onConnect = function(frame) {
		setConnected(true);
		console.log('Connected: ' + frame);
		stompClient.subscribe('/user/queue/login', (loginResponse) => {
			let parsed = JSON.parse(loginResponse.body);
			let success = parsed.success;
			let errorMessage = parsed.errorMessage;
			let loginError = document.getElementById("loginError");

			document.getElementById("spinner").classList.add("d-none");

			setLoggedIn(success);
			if (success) {
				loginError.classList.add("invisible");
				loginError.innerText = ".";
			} else if (errorMessage) {
				loginError.innerText = errorMessage;
				loginError.classList.remove("invisible");
				document.getElementById("form-signin").classList.remove("d-none");
			}
		});
		stompClient.subscribe('/user/queue/incomingMessage', (incomingMessage) => {
			let parsed = JSON.parse(incomingMessage.body);
			let from = parsed.from;
			addMessageToChatContent(new Date(parsed.timestamp), false, from, parsed.message, showChatWindow(from));
		});
		stompClient.subscribe('/user/queue/roster', function(roster) {
			var rosterChange = JSON.parse(roster.body);

			// entriesAdded
			var entriesAdded = rosterChange.entriesAdded;
			if (entriesAdded) {
				for ( let user of entriesAdded) {
					var existingLi = findRosterEntryByJid(user.jid); // avoid duplicates if it already exists
					if (!existingLi) {
						var li = document.createElement("li");
						li.className = "entry";
						li.setAttribute('data-jid', user.jid);
						li.setAttribute('data-name', user.name);
						li.setAttribute('title', user.name === user.jid ? user.jid : (user.name + " (" + user.jid + ")"));
						var divName = document.createElement("div");
						divName.className = "jid";
						divName.innerText = user.name;
						var divPresence = document.createElement("div");
						divPresence.className = "presence";
						divPresence.innerText = user.presence;
						li.appendChild(divName);
						li.appendChild(divPresence);
						var roster = document.getElementById("roster");
						roster.appendChild(li);
					}
				}
			}

			// presenceChanged
			var presenceChanged = rosterChange.presenceChanged;
			for ( var jid in presenceChanged) {
				var jidEntry = Array.from(document.querySelectorAll("#roster .entry")).find(el => el.dataset.jid === jid);
				if (jidEntry) {
					jidEntry.querySelector(".presence").innerText = presenceChanged[jid];
				}
			}
		});
		stompClient.subscribe('/user/queue/chatState', (json) => {
			let chatState = JSON.parse(json.body);
			let chatWindow = getChatWindow(chatState.jid);
			if (chatWindow) {
				let chatContent = chatWindow.querySelector(".chatContent");
				let alreadyAtBottom = chatContent.scrollHeight - chatContent.scrollTop === chatContent.clientHeight; // https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollHeight#Determine_if_an_element_has_been_totally_scrolled

				let chatStateDisplay = chatState.state === 'active' ? '' : jidToName(chatState.jid) + " is " + chatState.state;
				chatWindow.querySelector(".chatState").innerText = chatStateDisplay;

				if (alreadyAtBottom) {
					chatContent.lastChild.scrollIntoView({ behavior: "smooth" });
				}
			}
		});
		stompClient.subscribe('/user/queue/fileTransfer', (json) => {
			let transfer = JSON.parse(json.body);
			if (transfer.status === "Initial" && !transfer.fileName) {
				let recipientJid = transfer.peer.localpart + "@" + transfer.peer.domain;
				let chatWindow = showChatWindow(recipientJid);
				let fileInput = chatWindow.querySelector("input[type=file]");

				let reader = new FileReader();
				reader.onload = function(e) {
					// create a a new filetransfer div in the chatContent div
					let chatContent = chatWindow.querySelector(".chatContent");
					let transferDiv = document.createElement("div");
					transferDiv.classList.add("filetransfer");
					transferDiv.id = transfer.streamID;
					let transferSpan = document.createElement("span");
					transferSpan.innerText = "sending file " + fileInput.files[0].name + " (" + filesize(fileInput.files[0].size) + ")";
					let wrapper = document.createElement("div");
					wrapper.classList.add("progress-wrapper");
					let transferProgress = document.createElement("progress");
					transferProgress.setAttribute("value", 0);
					transferProgress.setAttribute("max", 1);
					let statusDiv = document.createElement("div");
					statusDiv.classList.add("status");
					statusDiv.innerText = transfer.status;
					wrapper.appendChild(transferProgress);
					wrapper.appendChild(statusDiv);
					transferDiv.appendChild(transferSpan);
					transferDiv.appendChild(wrapper);
					chatContent.insertBefore(transferDiv, chatContent.lastChild); // insert before the chat state div

					// scroll to bottom
					chatContent.lastChild.scrollIntoView({ behavior: "smooth" });

					// send the file to the server
					stompClient.publish({
						destination: '/app/sendOutgoingFile',
						binaryBody: new Uint8Array(e.target.result),
						headers: {
							'content-type': fileInput.files[0].type,
							'filename': fileInput.files[0].name,
							'stream': transfer.streamID
						}
					});
					fileInput.value = null; // clear file input to allow sending of the same file again
				}
				reader.readAsArrayBuffer(fileInput.files[0]);
			} else {
				let transferDiv = document.getElementById(transfer.streamID);
				if (transferDiv) {
					// show progress wrapper if hidden (used by incoming file transfers)
					let wrapper = transferDiv.querySelector(".progress-wrapper");
					wrapper.classList.remove("d-none");

					let statusDiv = transferDiv.querySelector(".status");
					statusDiv.innerText = transfer.status;
					let transferProgress = transferDiv.querySelector("progress");
					if (transfer.progress >= 0) {
						transferProgress.setAttribute("value", transfer.progress);
					} else {
						transferProgress.removeAttribute("value");
					}
				}
			}
		});
		stompClient.subscribe('/user/queue/incomingFileTransferRequest', (json) => {
			let transferRequest = JSON.parse(json.body);

			// show chat window
			let fromJid = transferRequest.requestor.localpart + "@" + transferRequest.requestor.domain;
			let chatWindow = showChatWindow(fromJid);

			// add incoming file transfer request prompt
			let incomingDiv = document.createElement("div");
			incomingDiv.classList.add("filetransfer");
			incomingDiv.id = transferRequest.streamID;
			let incomingSpan = document.createElement("span");
			incomingSpan.innerText = jidToName(fromJid) + " wants to send you " + transferRequest.fileName + " (" + filesize(transferRequest.fileSize) + ")";
			let actionsDiv = document.createElement("div");
			actionsDiv.classList.add("actions");
			let acceptLink = document.createElement("a");
			acceptLink.classList.add("accept");
			acceptLink.innerText = "Accept";
			acceptLink.setAttribute("href", "downloadIncomingFile?streamId=" + transferRequest.streamID + "&sessionId=" + json.headers["session-id"]);
			let rejectLink = document.createElement("a");
			rejectLink.classList.add("reject");
			rejectLink.innerText = "Reject";
			rejectLink.setAttribute("href", "#");
			actionsDiv.appendChild(acceptLink);
			actionsDiv.appendChild(rejectLink);
			let wrapper = document.createElement("div");
			wrapper.classList.add("progress-wrapper");
			wrapper.classList.add("d-none");
			let transferProgress = document.createElement("progress");
			transferProgress.setAttribute("value", 0);
			transferProgress.setAttribute("max", 1);
			let statusDiv = document.createElement("div");
			statusDiv.classList.add("status");
			wrapper.appendChild(transferProgress);
			wrapper.appendChild(statusDiv);
			incomingDiv.appendChild(incomingSpan);
			incomingDiv.appendChild(actionsDiv);
			incomingDiv.appendChild(wrapper);
			let chatContent = chatWindow.querySelector(".chatContent");
			chatContent.insertBefore(incomingDiv, chatContent.lastChild); // insert before the chat state div

			// scroll to bottom
			chatContent.lastChild.scrollIntoView({ behavior: "smooth" });
		});
	};
	stompClient.activate();
}

function sendMessage(event) {
	var chatWindow = event.target.closest(".chatWindow");
	var jid = chatWindow.dataset.jid;
	var chatInput = event.target.chatInput;
	var inputValue = chatInput.value;

	if (inputValue !== "") {
		// send to server
		stompClient.publish({destination: '/app/outgoingMessage', body: JSON.stringify({
			'message' : inputValue,
			'to' : jid
		})});
	
		// add message to chat content
		addMessageToChatContent(new Date(), true, myJid, inputValue, chatWindow);
		
		// clear input
		chatInput.value = "";
	}
}

function addMessageToChatContent(timestamp, mine, fromJid, messageBody, chatWindow) {
	var message = document.createElement("div");
	message.classList.add("message", mine ? "mine" : "theirs");
	var timestampSpan = document.createElement("span");
	timestampSpan.className = "timestamp";
	timestampSpan.innerText = timestamp.toLocaleTimeString();
	var from = document.createElement("span");
	from.className = "from";
	from.innerText = jidToName(fromJid);
	var body = document.createElement("span");
	body.className = "body";
	body.innerText = messageBody;
	message.appendChild(timestampSpan);
	message.appendChild(from);
	message.appendChild(body);
	var chatContent = chatWindow.querySelector(".chatContent");
	chatContent.insertBefore(message, chatContent.lastChild); // insert before the chat state div

	// scroll to bottom
	chatContent.lastChild.scrollIntoView({ behavior: "smooth" });
}

function findRosterEntryByJid(jid) {
	return Array.from(document.querySelectorAll("#roster .entry")).find(el => el.dataset.jid === jid);
}

function jidToName(jid) {
	let jidEntry = findRosterEntryByJid(jid);
	return jidEntry ? jidEntry.dataset.name : jid;
}

function jidToFullDisplay(jid) {
	let name = jidToName(jid);
	return (name === jid) ? jid : (name + " (" + jid + ")");
}

function getChatWindow(jid) {
	let chatWindows = document.getElementById("chatWindows");
	return Array.from(chatWindows.getElementsByClassName("chatWindow")).find(el => el.dataset.jid === jid);
}

function showChatWindow(jid) {
	var chatWindows = document.getElementById("chatWindows");

	// check if a chat with this jid is already open
	var jidChatWindow = getChatWindow(jid);
	if (!jidChatWindow) {
		var chatWindow = document.createElement("div");
		chatWindow.className = "chatWindow";
		chatWindow.dataset.jid = jid;

		var chatTitle = document.createElement("div");
		chatTitle.className = "chatTitle";

		var name = document.createElement("span");
		name.className = "name";
		name.innerText = jidToName(jid);
		name.setAttribute("title", jidToFullDisplay(jid));

		var close = document.createElement("span");
		close.className = "close";

		var chatContent = document.createElement("div");
		chatContent.className = "chatContent";

		var chatState = document.createElement("div");
		chatState.className = "chatState";

		// wrap input in form so we can deal with submit event instead of
		// keypress event, etc.
		var form = document.createElement("form");

		var chatInput = document.createElement("input");
		chatInput.className = "chatInput";
		chatInput.setAttribute("type", "text");
		chatInput.name = "chatInput";
		chatInput.setAttribute("autocomplete", "off");

		var fileLabel = document.createElement("label");

		var fileInput = document.createElement("input");
		fileInput.setAttribute("type", "file");
		fileInput.name = "file";

		chatTitle.appendChild(name);
		chatTitle.appendChild(close);
		chatWindow.appendChild(chatTitle);
		chatContent.appendChild(chatState);
		chatWindow.appendChild(chatContent);
		fileLabel.appendChild(fileInput);
		form.appendChild(fileLabel);
		form.appendChild(chatInput);
		chatWindow.appendChild(form);
		chatWindows.prepend(chatWindow);

		jidChatWindow = chatWindow;
	}
	return jidChatWindow;
}

function clearTimeoutByJid(jid) {
	if (jidToTimeout[jid]) {
		clearTimeout(jidToTimeout[jid]);
	}
}

function setChatState(jid, state) {
	var chatWindow = getChatWindow(jid);

	// only do stuff if the chat state has actually changed
	if (chatWindow.dataset.state !== state) {
		chatWindow.dataset.state = state;

		stompClient.publish({destination: '/app/chatState', body: JSON.stringify({
			jid : jid,
			state : state
		})});
	}
}

function handleChatInput(jid, chatInputValue) {
	if (chatInputValue === '') {
		clearTimeoutByJid(jid);
		setChatState(jid, "active");
		jidToTimeout[jid] = setTimeout(() => setChatState(jid, "inactive"), 120000);
	} else {
		clearTimeoutByJid(jid);
		setChatState(jid, "composing");
		jidToTimeout[jid] = setTimeout(() => setChatState(jid, "paused"), 5000);
	}
}

(function() {
	// event handlers
	document.getElementById("form-signin").addEventListener('submit', (event) => {
		event.preventDefault();

		document.getElementById("loginError").classList.add("invisible");
		document.getElementById("loginError").innerText = ".";
		document.getElementById("form-signin").classList.add("d-none");
		document.getElementById("spinner").classList.remove("d-none");

		// send to server
		stompClient.publish({destination: '/app/login', body: JSON.stringify({
			'jid' : event.target.inputEmail.value,
			'password' : event.target.inputPassword.value
		})});
	});
	document.getElementById("form-logout").addEventListener('submit', (event) => {
		event.preventDefault();
		
		setLoggedIn(false);

		// send to server
		stompClient.publish({destination: '/app/logout'});
	});
	document.getElementById("roster").addEventListener('click', (event) => {
		var parent = event.target.parentNode;
		if (parent.classList.contains('entry')) {
			let chatWindow = showChatWindow(parent.dataset.jid);
			chatWindow.querySelector(".chatInput").focus();
		}
	});
	document.getElementById("chatWindows").addEventListener('click', (event) => {
		if (event.target.classList.contains('close')) {
			event.target.closest(".chatWindow").remove();
		} else if (event.target.classList.contains('reject')) {
			event.preventDefault();

			// remove actions
			let transferDiv = event.target.closest(".filetransfer");
			event.target.closest(".actions").remove();

			// reject the transfer
			stompClient.publish({
				destination: '/app/rejectIncomingFile',
				body: transferDiv.id
			});
		} else if (event.target.classList.contains('accept')) {
			// remove actions
			let transferDiv = event.target.closest(".filetransfer");
			event.target.closest(".actions").remove();
		}
	});
	document.getElementById("chatWindows").addEventListener('submit', (event) => {
		event.preventDefault();
		sendMessage(event);

		let chatWindow = event.target.closest(".chatWindow");
		let jid = chatWindow.dataset.jid;
		// clears outstanding timeouts and changes state to active
		handleChatInput(jid, "");
	});
	document.getElementById("chatWindows").addEventListener('input', (event) => {
		if (event.target.classList.contains('chatInput')) {
			let chatInputValue = event.target.value;
			let chatWindow = event.target.closest(".chatWindow");
			let jid = chatWindow.dataset.jid;
			handleChatInput(jid, chatInputValue);
		}
	});
	document.getElementById("chatWindows").addEventListener('change', (event) => {
		if (event.target.name === "file" && event.target.files.length > 0) {
			stompClient.publish({
				destination: '/app/initiateOutgoingFile',
				body: event.target.closest(".chatWindow").dataset.jid
			});
		}
	});

	connect();
})();