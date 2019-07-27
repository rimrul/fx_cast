"use strict";

import bridge from "./lib/bridge";
import loadSender from "./lib/loadSender";
import options from "./lib/options";

import { TypedEventTarget } from "./lib/typedEvents";
import { Message } from "./types";

import { ReceiverSelectorMediaType } from "./receiver_selectors";

import SelectorManager from "./SelectorManager";
import StatusManager from "./StatusManager";


type Port = browser.runtime.Port | MessagePort;

export interface Shim {
    bridgePort: browser.runtime.Port;
    contentPort: Port;
    contentTabId?: number;
    contentFrameId?: number;
}


const activeShims = new Set<Shim>();

StatusManager.addEventListener("serviceUp", ev => {
    for (const shim of activeShims) {
        shim.contentPort.postMessage({
            subject: "shim:/serviceUp"
          , data: { id: ev.detail.id }
        });
    }
});

StatusManager.addEventListener("serviceDown", ev => {
    for (const shim of activeShims) {
        shim.contentPort.postMessage({
            subject: "shim:/serviceDown"
          , data: { id: ev.detail.id }
        });
    }
});


async function createShim (port: Port): Promise<void> {
    const shim = await (port instanceof MessagePort
        ? createShimFromBackground(port)
        : createShimFromContent(port));

    shim.contentPort.postMessage({
        subject: "shim:/initialized"
      , data: await bridge.getInfo()
    });

    activeShims.add(shim);
}


async function createShimFromBackground (
        contentPort: MessagePort): Promise<Shim> {

    const shim: Shim = {
        bridgePort: await bridge.connect()
      , contentPort
    };

    shim.bridgePort.onDisconnect.addListener(() => {
        contentPort.close();
        activeShims.delete(shim);
    });

    shim.bridgePort.onMessage.addListener((message: Message) => {
        contentPort.postMessage(message);
    });

    contentPort.onmessage = ev => {
        const message = ev.data as Message;
        handleContentMessage(shim, message);
    };

    return shim;
}


async function createShimFromContent (
        contentPort: browser.runtime.Port): Promise<Shim> {

    /**
     * If there's already an active shim for the sender
     * tab/frame ID, disconnect it.
     */
    for (const activeShim of activeShims) {
        if (activeShim.contentTabId === contentPort.sender.tab.id
         && activeShim.contentFrameId === contentPort.sender.frameId) {
            activeShim.bridgePort.disconnect();
        }
    }

    const shim: Shim = {
        bridgePort: await bridge.connect()
      , contentPort
      , contentTabId: contentPort.sender.tab.id
      , contentFrameId: contentPort.sender.frameId
    };

    function onContentPortMessage (message: Message) {
        handleContentMessage(shim, message);
    }
    function onBridgePortMessage (message: Message) {
        contentPort.postMessage(message);
    }

    function onDisconnect () {
        shim.bridgePort.onMessage.removeListener(onBridgePortMessage);
        contentPort.onMessage.removeListener(onContentPortMessage);

        shim.bridgePort.disconnect();
        contentPort.disconnect();

        activeShims.delete(shim);
    }


    shim.bridgePort.onDisconnect.addListener(onDisconnect);
    shim.bridgePort.onMessage.addListener(onBridgePortMessage);

    contentPort.onDisconnect.addListener(onDisconnect);
    contentPort.onMessage.addListener(onContentPortMessage);


    return shim;
}


async function handleContentMessage (shim: Shim, message: Message) {
    const [ destination ] = message.subject.split(":/");
    if (destination === "bridge") {
        shim.bridgePort.postMessage(message);
    }

    switch (message.subject) {
        case "main:/shimInitialized": {
            for (const receiver of StatusManager.getReceivers()) {
                shim.contentPort.postMessage({
                    subject: "shim:/serviceUp"
                  , data: { id: receiver.id }
                });
            }

            break;
        }

        case "main:/selectReceiverBegin": {
            const allMediaTypes =
                    ReceiverSelectorMediaType.App
                  | ReceiverSelectorMediaType.Tab
                  | ReceiverSelectorMediaType.Screen
                  | ReceiverSelectorMediaType.File;

            try {
                const selection = await SelectorManager.getSelection(
                        ReceiverSelectorMediaType.App
                      , allMediaTypes);

                // Handle cancellation
                if (!selection) {
                    shim.contentPort.postMessage({
                        subject: "shim:/selectReceiverCancelled"
                    });

                    break;
                }

                /**
                 * If the media type returned from the selector has been
                 * changed, we need to cancel the current sender and switch
                 * it out for the right one.
                 */
                if (selection.mediaType !== ReceiverSelectorMediaType.App) {
                    shim.contentPort.postMessage({
                        subject: "shim:/selectReceiverCancelled"
                    });

                    loadSender({
                        tabId: shim.contentTabId
                      , frameId: shim.contentFrameId
                      , selection
                    });

                    break;
                }

                // Pass selection back to shim
                shim.contentPort.postMessage({
                    subject: "shim:/selectReceiverEnd"
                  , data: selection
                });

            } catch (err) {
                // TODO: Report errors properly
                shim.contentPort.postMessage({
                    subject: "shim:/selectReceiverCancelled"
                });
            }

            break;
        }

        /**
         * TODO: If we're closing a selector, make sure it's the
         * same one that caused the session creation.
         */
        case "main:/sessionCreated": {
            const selector = await SelectorManager.getSharedSelector();

            const shouldClose = await options.get(
                    "receiverSelectorWaitForConnection");

            if (selector.isOpen && shouldClose) {
                selector.close();
            }

            break;
        }
    }
}

export default createShim;
