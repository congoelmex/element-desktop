/*
Copyright 2022 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { ipcMain } from "electron";
import { promises as afs } from "fs";
import path from "path";

import type {
    Seshat as SeshatType,
    SeshatRecovery as SeshatRecoveryType,
    ReindexError as ReindexErrorType,
} from "matrix-seshat"; // Hak dependency type
import IpcMainEvent = Electron.IpcMainEvent;
import { randomArray } from "./utils";
import { keytar } from "./keytar";
import { getInstances } from "./instances";

let seshatSupported = false;
let Seshat: typeof SeshatType;
let SeshatRecovery: typeof SeshatRecoveryType;
let ReindexError: typeof ReindexErrorType;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const seshatModule = require('matrix-seshat');
    Seshat = seshatModule.Seshat;
    SeshatRecovery = seshatModule.SeshatRecovery;
    ReindexError = seshatModule.ReindexError;
    seshatSupported = true;
} catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
        console.log("Seshat isn't installed, event indexing is disabled.");
    } else {
        console.warn("Seshat unexpected error:", e);
    }
}

const seshatDefaultPassphrase = "DEFAULT_PASSPHRASE";
async function getOrCreatePassphrase(key: string): Promise<string> {
    if (keytar) {
        try {
            const storedPassphrase = await keytar.getPassword("element.io", key);
            if (storedPassphrase !== null) {
                return storedPassphrase;
            } else {
                const newPassphrase = await randomArray(32);
                await keytar.setPassword("element.io", key, newPassphrase);
                return newPassphrase;
            }
        } catch (e) {
            console.log("Error getting the event index passphrase out of the secret store", e);
        }
    } else {
        return seshatDefaultPassphrase;
    }
}

const deleteContents = async (p: string): Promise<void> => {
    for (const entry of await afs.readdir(p)) {
        const curPath = path.join(p, entry);
        await afs.unlink(curPath);
    }
};

ipcMain.on('seshat', async function(ev: IpcMainEvent, payload): Promise<void> {
    const instance = getInstances().find(i => i.session === ev.sender.session);
    if (!instance) return;
    const eventStorePath = path.join(instance.session.getStoragePath(), 'EventStore');

    const sendError = (id, e) => {
        const error = {
            message: e.message,
        };
        ev.sender.send('seshatReply', {
            id: id,
            error: error,
        });
    };

    const args = payload.args || [];
    let ret: any;

    switch (payload.name) {
        case 'supportsEventIndexing':
            ret = seshatSupported;
            break;

        case 'initEventIndex':
            if (instance.eventIndex === null) {
                const userId = args[0];
                const deviceId = args[1];
                const passphraseKey = `seshat|${userId}|${deviceId}`;

                const passphrase = await getOrCreatePassphrase(passphraseKey);

                try {
                    await afs.mkdir(eventStorePath, { recursive: true });
                    instance.eventIndex = new Seshat(eventStorePath, { passphrase });
                } catch (e) {
                    if (e instanceof ReindexError) {
                        // If this is a reindex error, the index schema
                        // changed. Try to open the database in recovery mode,
                        // reindex the database and finally try to open the
                        // database again.
                        const recoveryIndex = new SeshatRecovery(eventStorePath, {
                            passphrase,
                        });

                        const userVersion = await recoveryIndex.getUserVersion();

                        // If our user version is 0 we'll delete the db
                        // anyways so reindexing it is a waste of time.
                        if (userVersion === 0) {
                            await recoveryIndex.shutdown();

                            try {
                                await deleteContents(eventStorePath);
                            } catch (e) {
                            }
                        } else {
                            await recoveryIndex.reindex();
                        }

                        instance.eventIndex = new Seshat(eventStorePath, { passphrase });
                    } else {
                        sendError(payload.id, e);
                        return;
                    }
                }
            }
            break;

        case 'closeEventIndex':
            if (instance.eventIndex !== null) {
                const index = instance.eventIndex;
                instance.eventIndex = null;

                try {
                    await index.shutdown();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'deleteEventIndex': {
            try {
                await deleteContents(eventStorePath);
            } catch (e) {

            }
            break;
        }

        case 'isEventIndexEmpty':
            if (instance.eventIndex === null) ret = true;
            else ret = await instance.eventIndex.isEmpty();
            break;

        case 'isRoomIndexed':
            if (instance.eventIndex === null) ret = false;
            else ret = await instance.eventIndex.isRoomIndexed(args[0]);
            break;

        case 'addEventToIndex':
            try {
                instance.eventIndex.addEvent(args[0], args[1]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'deleteEvent':
            try {
                ret = await instance.eventIndex.deleteEvent(args[0]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'commitLiveEvents':
            try {
                ret = await instance.eventIndex.commit();
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'searchEventIndex':
            try {
                ret = await instance.eventIndex.search(args[0]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'addHistoricEvents':
            if (instance.eventIndex === null) ret = false;
            else {
                try {
                    ret = await instance.eventIndex.addHistoricEvents(
                        args[0], args[1], args[2]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'getStats':
            if (instance.eventIndex === null) ret = 0;
            else {
                try {
                    ret = await instance.eventIndex.getStats();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'removeCrawlerCheckpoint':
            if (instance.eventIndex === null) ret = false;
            else {
                try {
                    ret = await instance.eventIndex.removeCrawlerCheckpoint(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'addCrawlerCheckpoint':
            if (instance.eventIndex === null) ret = false;
            else {
                try {
                    ret = await instance.eventIndex.addCrawlerCheckpoint(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'loadFileEvents':
            if (instance.eventIndex === null) ret = [];
            else {
                try {
                    ret = await instance.eventIndex.loadFileEvents(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'loadCheckpoints':
            if (instance.eventIndex === null) ret = [];
            else {
                try {
                    ret = await instance.eventIndex.loadCheckpoints();
                } catch (e) {
                    ret = [];
                }
            }
            break;

        case 'setUserVersion':
            if (instance.eventIndex === null) break;
            else {
                try {
                    await instance.eventIndex.setUserVersion(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'getUserVersion':
            if (instance.eventIndex === null) ret = 0;
            else {
                try {
                    ret = await instance.eventIndex.getUserVersion();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        default:
            ev.sender.send('seshatReply', {
                id: payload.id,
                error: "Unknown IPC Call: " + payload.name,
            });
            return;
    }

    ev.sender.send('seshatReply', {
        id: payload.id,
        reply: ret,
    });
});
