#!/usr/bin/env node
// 由环境变量 ADMIN_TOTP_SECRET（base32）计算当前 6 位 TOTP，参数与 worker src/lib/totp.ts 一致（SHA-1、30s）
import { createHmac } from 'node:crypto';

const secret = (process.env.ADMIN_TOTP_SECRET ?? '').replace(/[\s=]/g, '').toUpperCase();
if (!/^[A-Z2-7]+$/.test(secret)) {
  console.error('ADMIN_TOTP_SECRET 需为 base32');
  process.exit(1);
}
let bits = '';
for (const ch of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0');
const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
const mac = createHmac('sha1', key).update(counter).digest();
const offset = mac[mac.length - 1] & 0x0f;
const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
console.log(String(code).padStart(6, '0'));
