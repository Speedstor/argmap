// Stands in for ssh-keygen when git signs a commit, on machines that do not have it.
// git runs:  <program> -Y sign -n git -f <key file> [-U] <file to sign>
// and expects the signature in "<file to sign>.sig".
import { readFileSync, writeFileSync } from 'node:fs';
import { parsePrivateKey, SignError, sshSign } from './sign.ts';

function fail(message: string): never {
  process.stderr.write(`argmap-ssh-sign: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
let action = '';
let namespace = 'git';
let keyFile = '';
let agent = false;
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string;
  if (arg === '-Y') action = args[++i] ?? '';
  else if (arg === '-n') namespace = args[++i] ?? '';
  else if (arg === '-f') keyFile = args[++i] ?? '';
  else if (arg === '-U') agent = true;
  else if (arg.startsWith('-O')) {
    if (arg === '-O') i++;
  } else rest.push(arg);
}

if (action !== 'sign') {
  fail(`this helper only signs. To check signatures, run "argmap verify". (git asked for: ${action || args.join(' ')})`);
}
if (agent) fail('user.signingkey holds a public key, which needs an SSH agent. Set it to the path of the private key file instead.');
const target = rest[0];
if (!keyFile || !target) fail('expected: -Y sign -n git -f <private key file> <file to sign>');

try {
  const key = parsePrivateKey(readFileSync(keyFile, 'utf8'));
  writeFileSync(`${target}.sig`, sshSign(readFileSync(target), key, namespace));
} catch (e) {
  if (e instanceof SignError) fail(e.message);
  fail(e instanceof Error ? e.message : String(e));
}
