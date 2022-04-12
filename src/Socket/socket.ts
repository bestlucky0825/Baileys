import { Boom } from '@hapi/boom'
import EventEmitter from 'events'
import { promisify } from 'util'
import WebSocket from 'ws'
import { proto } from '../../WAProto'
import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, DEFAULT_ORIGIN, KEY_BUNDLE_TYPE, MIN_PREKEY_COUNT } from '../Defaults'
import { AuthenticationCreds, BaileysEventEmitter, BaileysEventMap, DisconnectReason, SocketConfig } from '../Types'
import { addTransactionCapability, bindWaitForConnectionUpdate, configureSuccessfulPairing, Curve, encodeBigEndian, generateLoginNode, generateMdTagPrefix, generateOrGetPreKeys, generateRegistrationNode, getPreKeys, makeNoiseHandler, printQRIfNecessaryListener, promiseTimeout, useSingleFileAuthState, xmppPreKey, xmppSignedPreKey } from '../Utils'
import { assertNodeErrorFree, BinaryNode, encodeBinaryNode, getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

const INITIAL_PREKEY_COUNT = 30

/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */
export const makeSocket = ({
	waWebSocketUrl,
	connectTimeoutMs,
	logger,
	agent,
	keepAliveIntervalMs,
	version,
	browser,
	auth: initialAuthState,
	printQRInTerminal,
	defaultQueryTimeoutMs
}: SocketConfig) => {
	const ws = new WebSocket(waWebSocketUrl, undefined, {
		origin: DEFAULT_ORIGIN,
		timeout: connectTimeoutMs,
		agent,
		headers: {
			'Accept-Encoding': 'gzip, deflate, br',
			'Accept-Language': 'en-US,en;q=0.9',
			'Cache-Control': 'no-cache',
			'Host': 'web.whatsapp.com',
			'Pragma': 'no-cache',
			'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits'
		}
	})
	ws.setMaxListeners(0)
	const ev = new EventEmitter() as BaileysEventEmitter
	/** ephemeral key pair used to encrypt/decrypt communication. Unique for each connection */
	const ephemeralKeyPair = Curve.generateKeyPair()
	/** WA noise protocol wrapper */
	const noise = makeNoiseHandler(ephemeralKeyPair)
	let authState = initialAuthState
	if(!authState) {
		authState = useSingleFileAuthState('./auth-info-multi.json').state

		logger.warn(`
            Baileys just created a single file state for your credentials. 
            This will not be supported soon.
            Please pass the credentials in the config itself
        `)
	}

	const { creds } = authState
	// add transaction capability
	const keys = addTransactionCapability(authState.keys, logger)

	let lastDateRecv: Date
	let epoch = 1
	let keepAliveReq: NodeJS.Timeout
	let qrTimer: NodeJS.Timeout

	const uqTagId = generateMdTagPrefix()
	const generateMessageTag = () => `${uqTagId}${epoch++}`

	const sendPromise = promisify<void>(ws.send)
	/** send a raw buffer */
	const sendRawMessage = async(data: Buffer | Uint8Array) => {
		if(ws.readyState !== ws.OPEN) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		const bytes = noise.encodeFrame(data)
        await sendPromise.call(ws, bytes) as Promise<void>
	}

	/** send a binary node */
	const sendNode = (frame: BinaryNode) => {
		if(logger.level === 'trace') {
			logger.trace({ msgId: frame.attrs.id, fromMe: true, frame }, 'communication')
		}

		const buff = encodeBinaryNode(frame)
		return sendRawMessage(buff)
	}

	/** log & process any unexpected errors */
	const onUnexpectedError = (error: Error, msg: string) => {
		logger.error(
			{ trace: error.stack, output: (error as any).output },
			`unexpected error in '${msg}'`
		)
	}

	/** await the next incoming message */
	const awaitNextMessage = async(sendMsg?: Uint8Array) => {
		if(ws.readyState !== ws.OPEN) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		let onOpen: (data: any) => void
		let onClose: (err: Error) => void

		const result = new Promise<any>((resolve, reject) => {
			onOpen = (data: any) => resolve(data)
			onClose = reject
			ws.on('frame', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		})
			.finally(() => {
				ws.off('frame', onOpen)
				ws.off('close', onClose)
				ws.off('error', onClose)
			})

		if(sendMsg) {
			sendRawMessage(sendMsg).catch(onClose)
		}

		return result
	}

	/**
     * Wait for a message with a certain tag to be received
     * @param tag the message tag to await
     * @param json query that was sent
     * @param timeoutMs timeout after which the promise will reject
     */
	 const waitForMessage = async(msgId: string, timeoutMs = defaultQueryTimeoutMs) => {
		let onRecv: (json) => void
		let onErr: (err) => void
		try {
			const result = await promiseTimeout(timeoutMs,
				(resolve, reject) => {
					onRecv = resolve
					onErr = err => {
						reject(err || new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed }))
					}

					ws.on(`TAG:${msgId}`, onRecv)
					ws.on('close', onErr) // if the socket closes, you'll never receive the message
					ws.off('error', onErr)
				},
			)
			return result as any
		} finally {
			ws.off(`TAG:${msgId}`, onRecv)
			ws.off('close', onErr) // if the socket closes, you'll never receive the message
			ws.off('error', onErr)
		}
	}

	/** send a query, and wait for its response. auto-generates message ID if not provided */
	const query = async(node: BinaryNode, timeoutMs?: number) => {
		if(!node.attrs.id) {
			node.attrs.id = generateMessageTag()
		}

		const msgId = node.attrs.id
		const wait = waitForMessage(msgId, timeoutMs)

		await sendNode(node)

		const result = await (wait as Promise<BinaryNode>)
		if('tag' in result) {
			assertNodeErrorFree(result)
		}

		return result
	}

	/** connection handshake */
	const validateConnection = async() => {
		let helloMsg: proto.IHandshakeMessage = {
			clientHello: { ephemeral: ephemeralKeyPair.public }
		}
		helloMsg = proto.HandshakeMessage.fromObject(helloMsg)

		logger.info({ browser, helloMsg, registrationId: creds.registrationId }, 'connected to WA Web')

		const init = proto.HandshakeMessage.encode(helloMsg).finish()

		const result = await awaitNextMessage(init)
		const handshake = proto.HandshakeMessage.decode(result)

		logger.trace({ handshake }, 'handshake recv from WA Web')

		const keyEnc = noise.processHandshake(handshake, creds.noiseKey)
		logger.info('handshake complete')

		let node: proto.IClientPayload
		if(!creds.me) {
			node = generateRegistrationNode(creds, { version, browser })
			logger.info({ node }, 'not logged in, attempting registration...')
		} else {
			node = generateLoginNode(creds.me!.id, { version, browser })
			logger.info({ node }, 'logging in...')
		}

		const payloadEnc = noise.encrypt(
			proto.ClientPayload.encode(node).finish()
		)
		await sendRawMessage(
			proto.HandshakeMessage.encode({
				clientFinish: {
					static: new Uint8Array(keyEnc),
					payload: new Uint8Array(payloadEnc),
				},
			}).finish()
		)
		noise.finishInit()
		startKeepAliveRequest()
	}

	/**
	 * get some pre-keys and do something with them
	 * @param range how many pre-keys to get
	 * @param execute what to do with them
	 */
	const assertingPreKeys = async(range: number, execute: (keys: { [_: number]: any }) => Promise<void>) => {
		const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(authState.creds, range)

		const update: Partial<AuthenticationCreds> = {
			nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
			firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
		}

		await keys.transaction(
			async() => {
				await keys.set({ 'pre-key': newPreKeys })

				const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])
				await execute(preKeys)
			}
		)

		ev.emit('creds.update', update)
	}

	const getAvailablePreKeysOnServer = async() => {
		const result = await query({
			tag: 'iq',
			attrs: {
				id: generateMessageTag(),
				xmlns: 'encrypt',
				type: 'get',
				to: S_WHATSAPP_NET
			},
			content: [
				{ tag: 'count', attrs: { } }
			]
		})
		const countChild = getBinaryNodeChild(result, 'count')
		return +countChild.attrs.value
	}

	/** generates and uploads a set of pre-keys to the server */
	const uploadPreKeys = async(count = INITIAL_PREKEY_COUNT) => {
		await assertingPreKeys(count, async preKeys => {
			logger.info('uploading pre-keys')

			const node: BinaryNode = {
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					xmlns: 'encrypt',
					type: 'set',
					to: S_WHATSAPP_NET,
				},
				content: [
					{ tag: 'registration', attrs: { }, content: encodeBigEndian(creds.registrationId) },
					{ tag: 'type', attrs: { }, content: KEY_BUNDLE_TYPE },
					{ tag: 'identity', attrs: { }, content: creds.signedIdentityKey.public },
					{ tag: 'list', attrs: { }, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
					xmppSignedPreKey(creds.signedPreKey)
				]
			}
			await query(node)

			logger.info('uploaded pre-keys')
		})
	}

	const uploadPreKeysToServerIfRequired = async() => {
		const preKeyCount = await getAvailablePreKeysOnServer()
		logger.info(`${preKeyCount} pre-keys found on server`)
		if(preKeyCount <= MIN_PREKEY_COUNT) {
			await uploadPreKeys()
		}
	}

	const onMessageRecieved = (data: Buffer) => {
		noise.decodeFrame(data, frame => {
			// reset ping timeout
			lastDateRecv = new Date()

			ws.emit('frame', frame)
			// if it's a binary node
			if(!(frame instanceof Uint8Array)) {
				const msgId = frame.attrs.id

				if(logger.level === 'trace') {
					logger.trace({ msgId, fromMe: false, frame }, 'communication')
				}

				let anyTriggered = false
				/* Check if this is a response to a message we sent */
				anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame)
				/* Check if this is a response to a message we are expecting */
				const l0 = frame.tag
				const l1 = frame.attrs || { }
				const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ''

				Object.keys(l1).forEach(key => {
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
				})
				anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
				anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered
				anyTriggered = ws.emit('frame', frame) || anyTriggered

				if(!anyTriggered && logger.level === 'debug') {
					logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv')
				}
			}
		})
	}

	const end = (error: Error | undefined) => {
		logger.info({ error }, 'connection closed')

		clearInterval(keepAliveReq)
		clearTimeout(qrTimer)

		ws.removeAllListeners('close')
		ws.removeAllListeners('error')
		ws.removeAllListeners('open')
		ws.removeAllListeners('message')

		if(ws.readyState !== ws.CLOSED && ws.readyState !== ws.CLOSING) {
			try {
				ws.close()
			} catch{ }
		}

		ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: {
				error,
				date: new Date()
			}
		})
		ev.removeAllListeners('connection.update')
	}

	const waitForSocketOpen = async() => {
		if(ws.readyState === ws.OPEN) {
			return
		}

		if(ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		let onOpen: () => void
		let onClose: (err: Error) => void
		await new Promise((resolve, reject) => {
			onOpen = () => resolve(undefined)
			onClose = reject
			ws.on('open', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		})
			.finally(() => {
				ws.off('open', onOpen)
				ws.off('close', onClose)
				ws.off('error', onClose)
			})
	}

	const startKeepAliveRequest = () => (
		keepAliveReq = setInterval(() => {
			if(!lastDateRecv) {
				lastDateRecv = new Date()
			}

			const diff = Date.now() - lastDateRecv.getTime()
			/*
                check if it's been a suspicious amount of time since the server responded with our last seen
                it could be that the network is down
            */
			if(diff > keepAliveIntervalMs + 5000) {
				end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }))
			} else if(ws.readyState === ws.OPEN) {
				// if its all good, send a keep alive request
				sendNode(
					{
						tag: 'iq',
						attrs: {
							id: generateMessageTag(),
							to: S_WHATSAPP_NET,
							type: 'get',
							xmlns: 'w:p',
						},
						content: [{ tag: 'ping', attrs: { } }]
					}
				)
					.catch(err => {
						logger.error({ trace: err.stack }, 'error in sending keep alive')
					})
			} else {
				logger.warn('keep alive called when WS not open')
			}
		}, keepAliveIntervalMs)
	)
	/** i have no idea why this exists. pls enlighten me */
	const sendPassiveIq = (tag: 'passive' | 'active') => (
		query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'passive',
				type: 'set',
			},
			content: [
				{ tag, attrs: { } }
			]
		})
	)

	const emitEventsFromMap = (map: Partial<BaileysEventMap<AuthenticationCreds>>) => {
		for(const key in map) {
			ev.emit(key as any, map[key])
		}
	}

	/** logout & invalidate connection */
	const logout = async() => {
		const jid = authState.creds.me?.id
		if(jid) {
			await sendNode({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					id: generateMessageTag(),
					xmlns: 'md'
				},
				content: [
					{
						tag: 'remove-companion-device',
						attrs: {
							jid,
							reason: 'user_initiated'
						}
					}
				]
			})
		}

		end(new Boom('Intentional Logout', { statusCode: DisconnectReason.loggedOut }))
	}

	ws.on('message', onMessageRecieved)
	ws.on('open', validateConnection)
	ws.on('error', end)
	ws.on('close', () => end(new Boom('Connection Terminated', { statusCode: DisconnectReason.connectionClosed })))
	// the server terminated the connection
	ws.on('CB:xmlstreamend', () => {
		end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed }))
	})
	// QR gen
	ws.on('CB:iq,type:set,pair-device', async(stanza: BinaryNode) => {
		const iq: BinaryNode = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'result',
				id: stanza.attrs.id,
			}
		}
		await sendNode(iq)

		const refs = ((stanza.content[0] as BinaryNode).content as BinaryNode[]).map(n => n.content as string)
		const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64')
		const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64')
		const advB64 = creds.advSecretKey

		let qrMs = 60_000 // time to let a QR live
		const genPairQR = () => {
			if(ws.readyState !== ws.OPEN) {
				return
			}

			const ref = refs.shift()
			if(!ref) {
				end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }))
				return
			}

			const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',')

			ev.emit('connection.update', { qr })

			qrTimer = setTimeout(genPairQR, qrMs)
			qrMs = 20_000 // shorter subsequent qrs
		}

		genPairQR()
	})
	// device paired for the first time
	// if device pairs successfully, the server asks to restart the connection
	ws.on('CB:iq,,pair-success', async(stanza: BinaryNode) => {
		logger.debug('pair success recv')
		try {
			const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)

			logger.debug('pairing configured successfully')

			const waiting = awaitNextMessage()
			await sendNode(reply)

			const value = (await waiting) as BinaryNode
			if(value.tag === 'stream:error') {
				if(value.attrs?.code !== '515') {
					throw new Boom('Authentication failed', { statusCode: +(value.attrs.code || 500) })
				}
			}

			logger.info({ jid: updatedCreds.me!.id }, 'registered connection, restart server')

			ev.emit('creds.update', updatedCreds)
			ev.emit('connection.update', { isNewLogin: true, qr: undefined })

			end(new Boom('Restart Required', { statusCode: DisconnectReason.restartRequired }))

			logger.warn('If your process stalls here, make sure to implement the reconnect logic as shown in ' +
						'https://github.com/adiwajshing/Baileys/blob/master/Example/example.ts#:~:text=reconnect')
		} catch(error) {
			logger.info({ trace: error.stack }, 'error in pairing')
			end(error)
		}
	})
	// login complete
	ws.on('CB:success', async() => {
		await uploadPreKeysToServerIfRequired()
		await sendPassiveIq('active')

		logger.info('opened connection to WA')
		clearTimeout(qrTimer) // will never happen in all likelyhood -- but just in case WA sends success on first try

		ev.emit('connection.update', { connection: 'open' })
	})

	ws.on('CB:ib,,offline', (node: BinaryNode) => {
		const child = getBinaryNodeChild(node, 'offline')
		const offlineCount = +child.attrs.count

		logger.info(`got ${offlineCount} offline messages/notifications`)

		ev.emit('connection.update', { receivedPendingNotifications: true })
	})

	ws.on('CB:stream:error', (node: BinaryNode) => {
		logger.error({ error: node }, 'stream errored out')

		const statusCode = +(node.attrs.code || DisconnectReason.restartRequired)
		end(new Boom('Stream Errored', { statusCode, data: node }))
	})
	// stream fail, possible logout
	ws.on('CB:failure', (node: BinaryNode) => {
		const reason = +(node.attrs.reason || 500)
		end(new Boom('Connection Failure', { statusCode: reason, data: node.attrs }))
	})

	ws.on('CB:ib,,downgrade_webclient', () => {
		end(new Boom('Multi-device beta not joined', { statusCode: DisconnectReason.multideviceMismatch }))
	})

	process.nextTick(() => {
		ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })
	})
	// update credentials when required
	ev.on('creds.update', update => {
		const name = update.me?.name
		// if name has just been received
		if(!creds.me?.name && name) {
			logger.info({ name }, 'received pushName')
			sendNode({
				tag: 'presence',
				attrs: { name }
			})
		}

		Object.assign(creds, update)
	})

	if(printQRInTerminal) {
		printQRIfNecessaryListener(ev, logger)
	}

	return {
		type: 'md' as 'md',
		ws,
		ev,
		authState: { creds, keys },
		get user() {
			return authState.creds.me
		},
		emitEventsFromMap,
		assertingPreKeys,
		generateMessageTag,
		query,
		waitForMessage,
		waitForSocketOpen,
		sendRawMessage,
		sendNode,
		logout,
		end,
		onUnexpectedError,
		uploadPreKeys,
		/** Waits for the connection to WA to reach a state */
		waitForConnectionUpdate: bindWaitForConnectionUpdate(ev)
	}
}

export type Socket = ReturnType<typeof makeSocket>