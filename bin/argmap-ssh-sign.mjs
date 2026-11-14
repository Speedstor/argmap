#!/usr/bin/env node
// Signs git commits with an ed25519 SSH key, without ssh-keygen. Set up with: argmap use-key <private key file>
import "../src/sign-cli.ts";
