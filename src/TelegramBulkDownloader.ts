import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import Byteroo, { Container } from 'byteroo';
import { Entity } from 'telegram/define';
import extractDisplayName from './helpers/extractDisplayName';
import ask from './helpers/ask';
import JsonSerializer from './helpers/JsonSerializer';
import checkbox from '@inquirer/checkbox';
import getInputFilter from './helpers/getInputFilter';
import getFilenameExtension from './helpers/getFilenameExtension';
import MediaType from './types/MediaType';
import { LogLevel } from 'telegram/extensions/Logger';
import cliProgress from 'cli-progress';

class TelegramBulkDownloader {
  private storage: Byteroo;
  private credentials: Container;
  private state: Container;
  isDownloading: boolean;
  private SIGINT: boolean;
  private client?: TelegramClient;
  private topicFilter: string | undefined;
  private alreadyDownloadedKeys: Set<string>;
  //private alreadyDownloadedKeys: string | undefined;
  private alreadyDownloadedFile: string | undefined;
  
  
  constructor() {
    this.alreadyDownloadedKeys = new Set<string>();
    this.alreadyDownloadedFile = '/home/andrea/downloaded_files.txt';
    this.topicFilter = process.argv[2];
    this.storage = new Byteroo({
      name: 'TelegramBulkDownloader',
      autocommit: true,
    });
    this.credentials = this.storage.getContainerSync(
      'credentials'
    ) as Container;
    this.state = this.storage.getContainerSync('state') as Container;
    this.isDownloading = false;
    this.SIGINT = false;
  }

  private async newDownload() {
    if (!this.client) throw new Error('TelegramClient undefined');
    const query = await inquirer.prompt([
      {
        name: 'id',
        message: 'Please enter username or chat id of target: ',
      },
    ]);

    try {
      const res = await this.client.getEntity(query.id);
      const { metadata } = await inquirer.prompt([
        {
          name: 'metadata',
          message: 'Do you want to include metadata.json? (Recommended: no)',
          type: 'confirm',
        },
      ]);
      let mediaTypes: MediaType[] = [];
      while (mediaTypes.length <= 0) {
        mediaTypes = await checkbox({
          message: 'Select media types to download',
          choices: [
            { name: 'Pictures', value: 'InputMessagesFilterPhotos' },
            { name: 'Videos', value: 'InputMessagesFilterVideo' },
            { name: 'Documents', value: 'InputMessagesFilterDocument' },
            { name: 'Music', value: 'InputMessagesFilterMusic' },
            { name: 'Voice messages', value: 'InputMessagesFilterVoice' },
            { name: 'GIFs', value: 'InputMessagesFilterGif' },
          ],
        });
      }
      const outPath = await ask('Enter the folder path for file storage: ');
      this.state.set(res.id.toString(), {
        displayName: extractDisplayName(res),
        entityJson: res.toJSON(),
        outPath: path.resolve(outPath),
        metadata,
        mediaTypes: mediaTypes.map((e) => ({ type: e, offset: 0 })),
        originalId: query.id
      });
      await this.download(res);
    } catch (err) {
      console.error('Failed to retrieve chat', err);
      this.main();
    }
  }

  private async download(entity: Entity) {
    if (!this.client) throw new Error('TelegramClient undefined');
    const id = entity.id.toString();

    for (const mediaType of this.state.get(id).mediaTypes) {
      await this.downloadMediaType(entity, mediaType.type);
    }

    this.state.remove(id);
    await this.state.commit();
    process.exit(0);
  }

  private async downloadMediaType(entity: Entity, mediaType: MediaType) {
  if (!this.client) throw new Error('TelegramClient undefined');
  this.isDownloading = true;
  const id = entity.id.toString();
  const latestMessage = await this.client.getMessages(entity, { limit: 1 });
  this.state.set(id, { ...this.state.get(id), limit: latestMessage[0].id });

  const metadataOption = this.state.get(id).metadata;
  let jsonSerializer;
  if (metadataOption) {
    jsonSerializer = new JsonSerializer(
      path.join(this.state.get(id).outPath, 'metadata.json')
    );
  }

  while (true) {
    const maxMessagesForCycle = 10000;
    const topicFilter = process.argv[2]; // esempio "10" oppure undefined
    
    type Message = any;
    let messages: Message[] = [];
    let offset = this.state
        .get(id)
        .mediaTypes.find((e: any) => e.type === mediaType).offset;

    while (messages.length < maxMessagesForCycle) {
      const messagesTmp = await this.client.getMessages(entity, {
        limit: maxMessagesForCycle,
        offsetId: offset,
        reverse: true,
        filter: getInputFilter(mediaType),
      });

      if (messagesTmp.length === 0) break; // non ci sono più messaggi da prendere

      // Esempio di controllo durante l'elaborazione dei messaggi
      this.alreadyDownloadedKeys = new Set<string>();
      this.loadAlreadyDownloadedKeys();


      // filtraggio nel ciclo messaggi
      const filteredMessages = messages.filter(m => {
        const key = this.makeKeyFromMessage(m);
        if (!key) return true; // scarica se non si può calcolare il filtro, per sicurezza
        return !this.alreadyDownloadedKeys.has(key);
      });

      // filtra solo quelli con topicFilter se è definito
      const filtered = topicFilter
        ? messagesTmp.filter(msg => msg.replyTo?.replyToMsgId?.toString() === topicFilter)
        : messagesTmp;

      if (filteredMessages) {
         messages = messages.concat(filtered);
      }

      // aggiorna offset per il prossimo ciclo
      offset = messagesTmp[messagesTmp.length - 1].id;
    }

    
    const mediaMessages = messages;

    const baseDownloadDir = this.state.get(id).outPath;
    if (!fs.existsSync(baseDownloadDir)) {
      fs.mkdirSync(baseDownloadDir, { recursive: true });
    }

    let msgId = offset;
 
      ////////
    for (const msg of mediaMessages) {

        let subfolder = 'NoTopic';
        if (msg.replyTo && msg.replyTo.replyToMsgId) {
          subfolder = `Topic_${msg.replyTo.replyToMsgId}`;
        }
        const downloadDir = path.join(baseDownloadDir, subfolder);

        if (!fs.existsSync(downloadDir)) {
          fs.mkdirSync(downloadDir, { recursive: true });
        }

        // Nome file personalizzato: parte con msg.id + "_" + fileName se presente, altrimenti estensione usata come prima
        const rawFileName = this.extractFileName(msg);
        const fileName = rawFileName ? `${msg.id}_${rawFileName}` : `${msg.id}.${getFilenameExtension(msg)}`;

        const filePath = path.join(downloadDir, fileName);

        const key = this.makeKeyFromMessage(msg);
        console.log(`${key}`);
        console.log(`${filePath}`);
        //rinomina file
       const extension = getFilenameExtension(msg);

       const rawFileName = this.extractFileName(msg);
       const documentId = msg.media?.document?.id?.toString(); // stringa
       const messageId = msg.id.toString();

       const fileName = rawFileName ? `${msg.id}_${rawFileName}` : `${msg.id}.${extension}`;
       const fileName1 = `${documentId}.${extension}`;
       const fileName2 = `document_${documentId}.${extension}`;
       const fileName3 = `${messageId}.${extension}`;

       const filePath = path.join(downloadDir, fileName);
       const filePath1 = path.join(downloadDir, fileName1);
       const filePath2 = path.join(downloadDir, fileName2);
       const filePath3 = path.join(downloadDir, fileName3);

       if (fs.existsSync(filePath1)) {
         await fs.promises.rename(filePath1, filePath);
       } else if (fs.existsSync(filePath2)) {
         await fs.promises.rename(filePath2, filePath);
       } else if (fs.existsSync(filePath3)) {
         await fs.promises.rename(filePath3, filePath);
       }

        
        this.loadAlreadyDownloadedKeys();
        const filteredMessages = !key || !this.alreadyDownloadedKeys.has(key);
      
        if (!filteredMessages) {
          console.log(`File ${filePath} già scaricato, salto download.`);
          continue;        
        }

      
    }
  }
}

  // Funzione di utilità per generare la stringa chiave da un messaggio
private makeKeyFromMessage(msg: any): string | null {
  if (!msg.media || !msg.media.document || !msg.media.document.attributes) return null;
  const doc = msg.media.document;
  const videoAttr = doc.attributes.find((attr: any) => attr.className === "DocumentAttributeVideo");
  if (!videoAttr) return null;

  // size è stringa, convertilo in numero
  const size = Number(doc.size);
  const duration = videoAttr.duration;
  const w = videoAttr.w;
  const h = videoAttr.h;
  if (size && duration && w && h) {
    return `${size},${duration},${w},${h}`;
  }
  return null;
}

// alla fine del download di un messaggio:
private onDownloadedMessage(m: any) {
  const key = this.makeKeyFromMessage(m);
  if (key) this.saveKey(key);
}


// caricamento da file esistente (implementa loading effettivo nella tua app)
private loadAlreadyDownloadedKeys() {
  // esempio semplice, sostituisci con fs.readFileSync e split sulla tua piattaforma Node.js
  //const lines = fs.readFileSync(this.alreadyDownloadedFile, 'utf8').split('\n');
  const lines = fs.readFileSync(this.alreadyDownloadedFile!, 'utf8').split('\n');
  for (const line of lines) {
    if (line.trim().length > 0) this.alreadyDownloadedKeys.add(line.trim());
  }
}

// salvataggio su file alla fine o dopo ogni download riuscito
private saveKey(key: string) {
  //fs.appendFileSync(this.alreadyDownloadedFile, key + '\n');
  fs.appendFileSync(this.alreadyDownloadedFile!, key + '\n', 'utf8');
}

  private extractFileName(msg: any): string | null {
    if (!msg.media || !msg.media.document || !Array.isArray(msg.media.document.attributes)) {
      return null;
    }
    const attr = msg.media.document.attributes.find((a: any) => typeof a.fileName === 'string');
    return attr ? attr.fileName : null;
  }

  private async resume() {
    if (!this.client) throw new Error('TelegramClient undefined');
    const res = await inquirer.prompt({
      name: 'resume',
      type: 'list',
      message: 'Choose a chat',
      choices: [
        ...this.state
          .list()
          .map((e) => ({ name: this.state.get(e).displayName || e, value: e })),
        { name: 'Back', value: 'backbutton' },
      ],
    });

    if (res.resume === 'backbutton') {
      return this.main();
    }

    const entityRes = await this.client.getEntity(
      this.state.get(res.resume).entityJson.username ||
        this.state.get(res.resume).originalId
    );
    this.download(entityRes);
  }

  async main() {
    //const topicFilter = process.argv[2]; // legge argomento come filtro
    let API_ID = this.credentials.get('API_ID');
    if (!API_ID) {
      API_ID = await ask('Please provide your API_ID: ');
      this.credentials.set('API_ID', API_ID);
    }

    let API_HASH = this.credentials.get('API_HASH');
    if (!API_HASH) {
      API_HASH = await ask('Please provide your API_HASH: ', {
        type: 'password',
      });
      this.credentials.set('API_HASH', API_HASH);
    }

    if (!this.client) {
      this.client = new TelegramClient(
        new StringSession(this.credentials.get('session')),
        parseInt(API_ID),
        API_HASH,
        {}
      );
      this.client.setLogLevel(LogLevel.NONE);
    }

    if (this.client.disconnected) {
      await this.client.start({
        phoneNumber: ask.bind(undefined, 'Please enter your phone number: '),
        password: ask.bind(undefined, 'Please enter your password: ', {
          type: 'password',
        }),
        phoneCode: ask.bind(undefined, 'Please enter the code you received: ', {
          type: 'password',
        }),
        onError: (err) => console.log(err),
      });

      this.credentials.set(
        'session',
        await (this.client as any).session.save()
      );
    }

    const menu = await inquirer.prompt({
      name: 'option',
      type: 'list',
      message: 'Choose an option',
      choices: [
        { name: 'Start new download', value: 'new_download' },
        { name: 'Resume active download', value: 'resume' },
        { name: 'Exit', value: 'exit' },
      ],
    });

    switch (menu.option) {
      case 'exit':
        process.exit(0);
      case 'new_download':
        this.newDownload();
        break;
      case 'resume':
        this.resume();
        break;
    }
  }

  run() {
    this.main();

    process.on('SIGINT', () => {
      console.log('Caught interrupt signal');
      if (!this.isDownloading) process.exit(0);
      this.SIGINT = true;
    });
  }

  getStoragePath() {
    return this.storage.path;
  }
}

export default TelegramBulkDownloader;
