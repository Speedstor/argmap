import { createHash, createPrivateKey, sign } from 'node:crypto';

export class SignError extends Error {}

function wire(...parts: (string | Buffer)[]): Buffer {
  return Buffer.concat(
    parts.map((part) => {
      const body = typeof part === 'string' ? Buffer.from(part) : part;
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      return Buffer.concat([length, body]);
    }),
  );
}

export interface PrivateKey {
  /** The 32-byte ed25519 seed. */
  seed: Buffer;
  /** The public key as SSH writes it: this, in base64, is what goes in allowed_signers. */
  publicBlob: Buffer;
  comment: string;
}

const MAGIC = Buffer.from('openssh-key-v1\0');

/**
 * Read an OpenSSH private key file (the kind `ssh-keygen -t ed25519` writes).
 * Only ed25519 keys without a passphrase are supported.
 */
export function parsePrivateKey(text: string): PrivateKey {
  if (!text.includes('BEGIN OPENSSH PRIVATE KEY')) {
    throw new SignError('This is not an OpenSSH private key file. It should start with "-----BEGIN OPENSSH PRIVATE KEY-----".');
  }
  const blob = Buffer.from(text.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new SignError('The private key file is damaged or not in OpenSSH format.');
  let at = MAGIC.length;
  let buf: Buffer = blob;
  const uint32 = (): number => {
    if (at + 4 > buf.length) throw new SignError('The private key file is cut short.');
    const n = buf.readUInt32BE(at);
    at += 4;
    return n;
  };
  const string = (): Buffer => {
    const n = uint32();
    if (at + n > buf.length) throw new SignError('The private key file is cut short.');
    const out = buf.subarray(at, at + n);
    at += n;
    return out;
  };
  const cipher = string().toString();
  string(); // kdf name
  string(); // kdf options
  if (cipher !== 'none') throw new SignError('This key has a passphrase. Only keys without one are supported.');
  if (uint32() !== 1) throw new SignError('The file holds more than one key.');
  const publicBlob = Buffer.from(string());
  const secret = string();

  buf = secret;
  at = 0;
  if (uint32() !== uint32()) throw new SignError('The private key file is damaged.');
  const type = string().toString();
  if (type !== 'ssh-ed25519') throw new SignError(`Key type ${type} is not supported. Only ssh-ed25519 keys are.`);
  const publicKey = string();
  const privateKey = string();
  const comment = string().toString();
  if (privateKey.length !== 64 || !privateKey.subarray(32).equals(publicKey)) throw new SignError('The private key file is damaged.');
  return { seed: Buffer.from(privateKey.subarray(0, 32)), publicBlob, comment };
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Sign data the way `ssh-keygen -Y sign` does, producing the armored SSH
 * signature git stores in a commit. The namespace for git commits is "git".
 */
export function sshSign(payload: Buffer, key: PrivateKey, namespace = 'git'): string {
  const keyObject = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, key.seed]), format: 'der', type: 'pkcs8' });
  const digest = createHash('sha512').update(payload).digest();
  const signature = sign(null, Buffer.concat([Buffer.from('SSHSIG'), wire(namespace, '', 'sha512', digest)]), keyObject);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from('SSHSIG'), version, wire(key.publicBlob, namespace, '', 'sha512', wire('ssh-ed25519', signature))]);
  const body = (blob.toString('base64').match(/.{1,70}/g) ?? []).join('\n');
  return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;
}

/** The key as a line for allowed_signers, without the name in front. */
export function publicLine(key: PrivateKey): string {
  return `ssh-ed25519 ${key.publicBlob.toString('base64')}`;
}
