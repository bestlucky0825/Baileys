import { WAMessage } from '../WAConnection/Constants'
import { proto } from '../Binary/WAMessage'
/**
 * set of statuses visible to other people; see updatePresence() in WhatsAppWeb.Send
 */
export enum Presence {
    available = 'available', // "online"
    unavailable = 'unavailable', // "offline"
    composing = 'composing', // "typing..."
    recording = 'recording', // "recording..."
    paused = 'paused', // I have no clue
}
/**
 * Status of a message sent or received
 */
export enum MessageStatus {
    sent = 'sent',
    received = 'received',
    read = 'read',
}
/**
 * set of message types that are supported by the library
 */
export enum MessageType {
    text = 'conversation',
    extendedText = 'extendedTextMessage',
    contact = 'contactMessage',
    location = 'locationMessage',
    liveLocation = 'liveLocationMessage',

    image = 'imageMessage',
    video = 'videoMessage',
    sticker = 'stickerMessage',
    document = 'documentMessage',
    audio = 'audioMessage',
}
/**
 * Tells us what kind of message it is
 */
export const MessageStubTypes = {
    20: 'addedToGroup',
    32: 'leftGroup',
    39: 'createdGroup',
}
export const HKDFInfoKeys = (function () {
    const dict: Record<string, string> = {}
    dict[MessageType.image] = 'WhatsApp Image Keys'
    dict[MessageType.video] = 'WhatsApp Audio Keys'
    dict[MessageType.document] = 'WhatsApp Document Keys'
    dict[MessageType.sticker] = 'WhatsApp Image Keys'
    return dict
})()
export enum Mimetype {
    jpeg = 'image/jpeg',
    mp4 = 'video/mp4',
    gif = 'video/gif',
    pdf = 'appliction/pdf',
    ogg = 'audio/ogg; codecs=opus',
    /** for stickers */
    webp = 'image/webp',
}
export interface MessageOptions {
    quoted?: WAMessage
    timestamp?: Date
    caption?: string
    thumbnail?: string
    mimetype?: Mimetype
}
export interface MessageStatusUpdate {
    from: string
    to: string
    participant?: string
    timestamp: Date
    /** Message IDs read/delivered */
    ids: string[]
    /** Status of the Message IDs */
    type: string
}
export interface PresenceUpdate {
    id: string
    type?: string
    deny?: boolean
}
// path to upload the media
export const MediaPathMap = {
    imageMessage: '/mms/image',
    videoMessage: '/mms/video',
    documentMessage: '/mms/document',
    audioMessage: '/mms/audio',
    stickerMessage: '/mms/image',
}
// gives WhatsApp info to process the media
export const MimetypeMap = {
    imageMessage: Mimetype.jpeg,
    videoMessage: Mimetype.mp4,
    documentMessage: Mimetype.pdf,
    audioMessage: Mimetype.ogg,
    stickerMessage: Mimetype.webp,
}
export interface WASendMessageResponse {
    status: number
    messageID: string
}
export interface WALocationMessage {
    degreesLatitude: number
    degreesLongitude: number
    address?: string
}
export type WAContactMessage = proto.ContactMessage
