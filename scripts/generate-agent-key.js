import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const prefix = process.argv[2] || "cohort-agent";
const privatePath = `${prefix}-private.pem`;
const publicPath = `${prefix}-public.pem`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 });

console.log(`Created ${privatePath} (keep secret) and ${publicPath} (register in the operator dashboard).`);
