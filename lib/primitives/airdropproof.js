'use strict';

const assert = require('bsert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const sha256 = require('bcrypto/lib/sha256');
const merkle = require('bcrypto/lib/mrkl');
const AirdropKey = require('./airdropkey');
const InvItem = require('./invitem');
const Input = require('./input');
const Output = require('./output');
const consensus = require('../protocol/consensus');
const {keyTypes} = AirdropKey;

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);
const SPONSOR_FEE = 500e6;
const RECIPIENT_FEE = 100e6;

const AIRDROP_ROOT = Buffer.from(
  '3d1bddfac73e3a4f25468ca038731e9498e1e6287d6534087552003cd99d54e1',
  'hex');

const AIRDROP_LEAVES = 204178;
const AIRDROP_SUBLEAVES = 60;
const AIRDROP_DEPTH = 18;
const AIRDROP_SUBDEPTH = 6;
const AIRDROP_REWARD = 4662598321;

const FAUCET_ROOT = Buffer.from(
  'ce58fb15d295d5b20d3c6b5f15d9cc9e4a587fd1cae6d4e4f5a3776538cb1aa1',
  'hex');

const FAUCET_LEAVES = 226;
const FAUCET_DEPTH = 8;

const TREE_LEAVES = AIRDROP_LEAVES + FAUCET_LEAVES;

/**
 * AirdropProof
 */

class AirdropProof extends bio.Struct {
  constructor() {
    super();
    this.index = 0;
    this.proof = [];
    this.subindex = 0;
    this.subproof = [];
    this.key = EMPTY;
    this.version = 0;
    this.address = EMPTY;
    this.fee = 0;
    this.signature = EMPTY;
  }

  getSize(sighash = false) {
    let size = 0;

    size += 4;
    size += 1;
    size += this.proof.length * 32;
    size += 1;
    size += 1;
    size += this.subproof.length * 32;
    size += bio.sizeVarBytes(this.key);
    size += 1;
    size += 1;
    size += this.address.length;
    size += bio.sizeVarint(this.fee);

    if (!sighash)
      size += bio.sizeVarBytes(this.signature);

    return size;
  }

  write(bw, sighash = false) {
    bw.writeU32(this.index);
    bw.writeU8(this.proof.length);

    for (const hash of this.proof)
      bw.writeBytes(hash);

    bw.writeU8(this.subindex);
    bw.writeU8(this.subproof.length);

    for (const hash of this.subproof)
      bw.writeBytes(hash);

    bw.writeVarBytes(this.key);
    bw.writeU8(this.version);
    bw.writeU8(this.address.length);
    bw.writeBytes(this.address);
    bw.writeVarint(this.fee);

    if (!sighash)
      bw.writeVarBytes(this.signature);

    return bw;
  }

  read(br) {
    this.index = br.readU32();

    const count = br.readU8();
    assert(count <= AIRDROP_DEPTH);

    for (let i = 0; i < count; i++) {
      const hash = br.readBytes(32);
      this.proof.push(hash);
    }

    this.subindex = br.readU8();

    const total = br.readU8();
    assert(total <= AIRDROP_SUBDEPTH);

    for (let i = 0; i < total; i++) {
      const hash = br.readBytes(32);
      this.subproof.push(hash);
    }

    this.key = br.readVarBytes();
    assert(this.key.length > 0);

    this.version = br.readU8();

    assert(this.version <= 31);

    const size = br.readU8();
    assert(size >= 2 && size <= 40);

    this.address = br.readBytes(size);
    this.fee = br.readVarint();
    this.signature = br.readVarBytes();

    return this;
  }

  verifyMerkle(expect) {
    if (expect == null) {
      expect = this.isAddress()
        ? FAUCET_ROOT
        : AIRDROP_ROOT;
    }

    assert(Buffer.isBuffer(expect));
    assert(expect.length === 32);

    const {subproof, subindex} = this;
    const {proof, index} = this;
    const leaf = blake2b.digest(this.key);

    if (this.isAddress()) {
      const root = merkle.deriveRoot(blake2b, leaf, proof, index);

      return root.equals(expect);
    }

    const subroot = merkle.deriveRoot(blake2b, leaf, subproof, subindex);
    const root = merkle.deriveRoot(blake2b, subroot, proof, index);

    return root.equals(expect);
  }

  signatureData() {
    const size = this.getSize(true);
    const bw = bio.pool(size);

    this.write(bw, true);

    return bw.render();
  }

  signatureHash() {
    return sha256.digest(this.signatureData());
  }

  getKey() {
    try {
      return AirdropKey.decode(this.key);
    } catch (e) {
      return null;
    }
  }

  verifySignature() {
    const key = this.getKey();

    if (!key)
      return false;

    if (key.isAddress()) {
      const fee = key.sponsor
        ? SPONSOR_FEE
        : RECIPIENT_FEE;

      return this.version === key.version
          && this.address.equals(key.address)
          && this.fee === fee
          && this.signature.length === 0;
    }

    const msg = key.isED25519()
      ? this.signatureData()
      : this.signatureHash();

    return key.verify(msg, this.signature);
  }

  position() {
    let index = this.index;

    // Position in the bitfield.
    // Bitfield is organized as:
    // [airdrop-bits] || [faucet-bits]
    if (this.isAddress()) {
      assert(index < FAUCET_LEAVES);
      index += AIRDROP_LEAVES;
    } else {
      assert(index < AIRDROP_LEAVES);
    }

    assert(index < TREE_LEAVES);

    return index;
  }

  toTX(TX) {
    const tx = new TX();

    tx.inputs.push(new Input());
    tx.outputs.push(new Output());

    const input = new Input();
    const output = new Output();

    input.witness.items.push(this.encode());

    output.value = this.getValue() - this.fee;
    output.address.version = this.version;
    output.address.hash = this.address;

    tx.inputs.push(input);
    tx.outputs.push(output);

    tx.refresh();

    return tx;
  }

  toInv() {
    return new InvItem(InvItem.types.AIRDROP, this.hash());
  }

  getWeight() {
    return this.getSize();
  }

  getVirtualSize() {
    const scale = consensus.WITNESS_SCALE_FACTOR;
    return (this.getWeight() + scale - 1) / scale | 0;
  }

  isWeak() {
    const key = this.getKey();

    if (!key)
      return false;

    return key.isWeak();
  }

  isAddress() {
    if (this.key.length === 0)
      return false;

    return this.key[0] === keyTypes.ADDRESS;
  }

  getValue() {
    if (!this.isAddress())
      return AIRDROP_REWARD;

    const key = this.getKey();

    if (!key)
      return 0;

    return key.value;
  }

  isSane() {
    if (this.key.length === 0)
      return false;

    if (this.version > 31)
      return false;

    if (this.address.length < 2 || this.address.length > 40)
      return false;

    if (this.fee > this.getValue())
      return false;

    if (this.isAddress()) {
      if (this.subproof.length !== 0)
        return false;

      if (this.subindex !== 0)
        return false;

      if (this.proof.length > FAUCET_DEPTH)
        return false;

      if (this.index >= FAUCET_LEAVES)
        return false;

      return true;
    }

    if (this.subproof.length > AIRDROP_SUBDEPTH)
      return false;

    if (this.subindex >= AIRDROP_SUBLEAVES)
      return false;

    if (this.proof.length > AIRDROP_DEPTH)
      return false;

    if (this.index >= AIRDROP_LEAVES)
      return false;

    return true;
  }

  verify(expect) {
    if (!this.isSane())
      return false;

    if (!this.verifyMerkle(expect))
      return false;

    if (!this.verifySignature())
      return false;

    return true;
  }

  getJSON() {
    const key = this.getKey();

    return {
      index: this.index,
      proof: this.proof.map(h => h.toString('hex')),
      subindex: this.subindex,
      subproof: this.subproof.map(h => h.toString('hex')),
      key: key ? key.toJSON() : null,
      version: this.version,
      address: this.address.toString('hex'),
      fee: this.fee,
      signature: this.signature.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert((json.index >>> 0) === json.index);
    assert(Array.isArray(json.proof));
    assert((json.subindex >>> 0) === json.subindex);
    assert(Array.isArray(json.subproof));
    assert(json.key == null || (json.key && typeof json.key === 'object'));
    assert((json.version & 0xff) === json.version);
    assert(typeof json.address === 'string');
    assert(Number.isSafeInteger(json.fee) && json.fee >= 0);
    assert(typeof json.signature === 'string');

    this.index = json.index;

    for (const hash of json.proof) {
      assert(typeof hash === 'string');
      assert(hash.length === 64);

      this.proof.push(Buffer.from(hash, 'hex'));
    }

    this.subindex = json.subindex;

    for (const hash of json.subproof) {
      assert(typeof hash === 'string');
      assert(hash.length === 64);

      this.subproof.push(Buffer.from(hash, 'hex'));
    }

    if (json.key)
      this.key = AirdropKey.fromJSON(json.key).encode();

    this.version = json.version;
    this.address = Buffer.from(json.address, 'hex');
    this.fee = json.fee;
    this.signature = Buffer.from(json.signature, 'hex');

    return this;
  }
}

AirdropProof.TREE_LEAVES = TREE_LEAVES;
AirdropProof.AIRDROP_LEAVES = AIRDROP_LEAVES;
AirdropProof.FAUCET_LEAVES = FAUCET_LEAVES;

/*
 * Expose
 */

module.exports = AirdropProof;