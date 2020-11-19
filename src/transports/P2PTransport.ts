import * as sodium from 'libsodium-wrappers'
import { Logger } from '../utils/Logger'
import { ConnectionContext } from '../types/ConnectionContext'
import {
  Storage,
  StorageKey,
  TransportStatus,
  Transport,
  TransportType,
  P2PCommunicationClient,
  Origin,
  P2PPairingRequest
} from '..'
import { PeerManager } from '../managers/PeerManager'
import { P2PPairingResponse } from '../types/P2PPairingResponse'

const logger = new Logger('P2PTransport')

export class P2PTransport extends Transport<P2PPairingResponse> {
  public readonly type: TransportType = TransportType.P2P

  /**
   * The client handling the encryption/decryption of messages
   */
  private readonly client: P2PCommunicationClient

  private readonly peerManager: PeerManager<StorageKey.TRANSPORT_P2P_PEERS>

  constructor(name: string, keyPair: sodium.KeyPair, storage: Storage, matrixNodes: string[]) {
    super(name)
    this.client = new P2PCommunicationClient(this.name, keyPair, 1, storage, matrixNodes, false)
    this.peerManager = new PeerManager(storage, StorageKey.TRANSPORT_P2P_PEERS)
  }

  public static async isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }

  public async connect(): Promise<void> {
    if (this._isConnected !== TransportStatus.NOT_CONNECTED) {
      return
    }

    logger.log('connect')
    this._isConnected = TransportStatus.CONNECTING

    await this.client.start()

    const knownPeers = await this.peerManager.getPeers()

    if (knownPeers.length > 0) {
      logger.log('connect', `connecting to ${knownPeers.length} peers`)
      const connectionPromises = knownPeers.map(async (peer) => this.listen(peer.publicKey))
      Promise.all(connectionPromises).catch(console.log)
    }

    await this.client.listenForChannelOpening(async (peer) => {
      logger.log('listenForNewPeer', `new publicKey`, peer.publicKey)

      await this.addPeer(peer as any)

      this._isConnected = TransportStatus.CONNECTED

      if (this.newPeerListener) {
        this.newPeerListener(peer)
        this.newPeerListener = undefined // TODO: Remove this once we use the id
      }
    })

    await super.connect()
  }

  public async getPairingRequestInfo(): Promise<P2PPairingRequest> {
    return this.client.getPairingRequestInfo()
  }

  public async getPeers(): Promise<P2PPairingRequest[]> {
    return this.peerManager.getPeers()
  }

  public async addPeer(newPeer: P2PPairingRequest): Promise<void> {
    if (!(await this.peerManager.hasPeer(newPeer.publicKey))) {
      logger.log('addPeer', newPeer)
      await this.peerManager.addPeer(newPeer)
      await this.listen(newPeer.publicKey) // TODO: Prevent channels from being opened multiple times
    } else {
      logger.log('addPeer', 'peer already added, skipping', newPeer)
    }
    await this.client.sendPairingResponse(newPeer) // TODO: Should we have a confirmation here?
  }

  public async removePeer(peerToBeRemoved: P2PPairingRequest): Promise<void> {
    logger.log('removePeer', peerToBeRemoved)
    await this.peerManager.removePeer(peerToBeRemoved.publicKey)
    if (this.client) {
      await this.client.unsubscribeFromEncryptedMessage(peerToBeRemoved.publicKey)
    }
  }

  public async removeAllPeers(): Promise<void> {
    logger.log('removeAllPeers')
    await this.peerManager.removeAllPeers()

    await this.client.unsubscribeFromEncryptedMessages()
  }

  public async send(message: string, recipient?: string): Promise<void> {
    const knownPeers = await this.peerManager.getPeers()

    if (recipient) {
      if (!knownPeers.some((peer) => peer.publicKey === recipient)) {
        throw new Error('Recipient unknown')
      }

      return this.client.sendMessage(recipient, message)
    } else {
      // A broadcast request has to be sent everywhere.
      const promises = knownPeers.map((peer) => this.client.sendMessage(peer.publicKey, message))

      return (await Promise.all(promises))[0]
    }
  }

  private async listen(publicKey: string): Promise<void> {
    await this.client
      .listenForEncryptedMessage(publicKey, (message) => {
        const connectionContext: ConnectionContext = {
          origin: Origin.P2P,
          id: publicKey
        }

        this.notifyListeners(message, connectionContext).catch((error) => {
          throw error
        })
      })
      .catch((error) => {
        throw error
      })
  }
}
