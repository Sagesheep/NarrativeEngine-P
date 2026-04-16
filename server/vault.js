import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// File format:
// [4B: magic "NEV1"]
// [16B: salt]
// [12B: IV]
// [4B: ciphertext length]
// [NB: AES-256-GCM ciphertext]
// [16B: GCM auth tag]

const MAGIC = Buffer.from('NEV1', 'utf-8');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 100000;

/**
 * Derive a 256-bit key from a password using PBKDF2
 */
function deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Get a machine-derived key based on hostname and username
 * Used when vault password is not set
 */
function getMachineKey() {
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const machine = `${hostname}:${username}`;
    // Use a fixed salt for machine keys (less secure, but convenient)
    return crypto.pbkdf2Sync(machine, 'NEVAULT_MACHINE_SALT_V1', 10000, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt data with AES-256-GCM
 * Returns buffer in the vault file format
 */
function encryptData(data, key) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    
    // Build output buffer
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(ciphertext.length, 0);
    
    return Buffer.concat([
        MAGIC,
        lengthBuffer,
        iv,
        ciphertext,
        tag
    ]);
}

/**
 * Decrypt data from vault format
 */
function decryptData(buffer, key) {
    // Verify magic
    if (!buffer.slice(0, 4).equals(MAGIC)) {
        throw new Error('Invalid vault file: wrong magic number');
    }
    
    const length = buffer.readUInt32BE(4);
    const iv = buffer.slice(8, 8 + IV_LENGTH);
    const ciphertext = buffer.slice(8 + IV_LENGTH, 8 + IV_LENGTH + length);
    const tag = buffer.slice(8 + IV_LENGTH + length, 8 + IV_LENGTH + length + TAG_LENGTH);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    
    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]);
    
    return JSON.parse(plaintext.toString('utf-8'));
}

/**
 * Vault operations class
 */
export class KeyVault {
    constructor(dataDir) {
        this.vaultPath = path.join(dataDir, 'apikeys.vault');
        this.rememberPath = path.join(dataDir, '.vault-remember');
        this.unlockedData = null;
        this.derivedKey = null; // cached key for "remember password"
        this.currentSalt = null; // cached salt for re-encryption
        this.isMachineKey = false; // track if using machine key
    }

    /**
     * Check if vault exists
     */
    exists() {
        return fs.existsSync(this.vaultPath);
    }

    /**
     * Check if vault is unlocked (has data in memory)
     */
    isUnlocked() {
        return this.unlockedData !== null;
    }

    /**
     * Check if there's a remembered key
     */
    hasRememberedKey() {
        return fs.existsSync(this.rememberPath);
    }

    /**
     * Create a new vault with password (or no password for machine-key mode)
     */
    create(data, password = null) {
        let encrypted;
        if (password) {
            const salt = crypto.randomBytes(SALT_LENGTH);
            const derivedKey = deriveKey(password, salt);
            const base = encryptData(data, derivedKey);
            encrypted = Buffer.concat([base, salt]);
            this.derivedKey = derivedKey;
            this.currentSalt = salt;
            this.isMachineKey = false;
        } else {
            encrypted = encryptData(data, getMachineKey());
            this.isMachineKey = true;
        }
        
        // Atomic write
        const tmpPath = this.vaultPath + '.tmp';
        fs.writeFileSync(tmpPath, encrypted);
        fs.renameSync(tmpPath, this.vaultPath);
        
        this.unlockedData = data;
    }

    /**
     * Unlock the vault with a password
     */
    unlock(password) {
        const encrypted = fs.readFileSync(this.vaultPath);
        
        // Check if this is password-protected (has salt at end) or machine-key.
        // Use the stored ciphertext length to compute exact expected sizes:
        // machine-key: MAGIC(4)+len(4)+IV(12)+cipher(N)+tag(16) = 36+N
        // password:    same + SALT_LENGTH(16) at end             = 52+N
        const ciphertextLength = encrypted.readUInt32BE(4);
        const hasSalt = encrypted.length === (4 + 4 + IV_LENGTH + ciphertextLength + TAG_LENGTH + SALT_LENGTH);
        
        if (hasSalt) {
            // Extract salt from end
            const salt = encrypted.slice(-SALT_LENGTH);
            const key = password ? deriveKey(password, salt) : null;
            
            if (!key) {
                throw new Error('Password required for password-protected vault');
            }
            
            // Decrypt without the salt
            const vaultData = encrypted.slice(0, -SALT_LENGTH);
            this.unlockedData = decryptData(vaultData, key);
            this.derivedKey = key;
            this.currentSalt = salt;
            this.isMachineKey = false;
            return true;
        } else {
            // Machine-key mode
            const key = getMachineKey();
            this.unlockedData = decryptData(encrypted, key);
            this.isMachineKey = true;
            return true;
        }
    }

    /**
     * Try to unlock with remembered key
     */
    unlockWithRemembered() {
        if (!this.hasRememberedKey()) return false;

        try {
            const hexKey = fs.readFileSync(this.rememberPath, 'utf-8').trim();
            const key = Buffer.from(hexKey, 'hex');

            const encrypted = fs.readFileSync(this.vaultPath);

            let vaultData;
            if (this.isMachineKey) {
                vaultData = encrypted;
            } else {
                vaultData = encrypted.slice(0, -SALT_LENGTH);
                this.currentSalt = encrypted.slice(-SALT_LENGTH);
            }

            this.unlockedData = decryptData(vaultData, key);
            this.derivedKey = key;
            return true;
        } catch (err) {
            this.clearRememberedKey();
            return false;
        }
    }

    /**
     * Lock the vault (clear memory)
     */
    lock() {
        this.unlockedData = null;
        this.derivedKey = null;
        this.currentSalt = null;
        this.isMachineKey = false;
    }

    /**
     * Get the unlocked data
     */
    getData() {
        if (!this.isUnlocked()) {
            throw new Error('Vault is locked');
        }
        return this.unlockedData;
    }

    /**
     * Save data to vault (must be unlocked)
     */
    saveData(data) {
        if (!this.isUnlocked()) {
            throw new Error('Vault is locked');
        }
        
        // Re-encrypt with same key
        let encrypted;
        if (this.isMachineKey) {
            encrypted = encryptData(data, getMachineKey());
        } else {
            if (!this.derivedKey || !this.currentSalt) {
                throw new Error('No key/salt available for re-encryption');
            }
            const base = encryptData(data, this.derivedKey);
            encrypted = Buffer.concat([base, this.currentSalt]);
        }
        
        const tmpPath = this.vaultPath + '.tmp';
        fs.writeFileSync(tmpPath, encrypted);
        fs.renameSync(tmpPath, this.vaultPath);
        
        this.unlockedData = data;
    }

    /**
     * Save remembered key for auto-unlock
     */
    saveRememberedKey() {
        if (!this.derivedKey) {
            throw new Error('No key to remember');
        }
        fs.writeFileSync(this.rememberPath, this.derivedKey.toString('hex'), 'utf-8');
    }

    /**
     * Clear remembered key
     */
    clearRememberedKey() {
        if (fs.existsSync(this.rememberPath)) {
            fs.unlinkSync(this.rememberPath);
        }
    }

    /**
     * Export vault with a different password
     */
    exportWithPassword(exportPassword) {
        if (!this.isUnlocked()) {
            throw new Error('Vault must be unlocked to export');
        }
        
        const salt = crypto.randomBytes(SALT_LENGTH);
        const key = deriveKey(exportPassword, salt);
        const base = encryptData(this.unlockedData, key);
        
        return Buffer.concat([base, salt]);
    }

    /**
     * Import vault from exported file
     */
    static importFromBuffer(buffer, importPassword) {
        // Extract salt from end
        if (buffer.length < SALT_LENGTH + MAGIC.length + 4 + IV_LENGTH + TAG_LENGTH) {
            throw new Error('Invalid export file');
        }
        
        const salt = buffer.slice(-SALT_LENGTH);
        const key = deriveKey(importPassword, salt);
        const vaultData = buffer.slice(0, -SALT_LENGTH);
        
        return decryptData(vaultData, key);
    }

    /**
     * Delete vault file
     */
    delete() {
        this.lock();
        if (fs.existsSync(this.vaultPath)) {
            fs.unlinkSync(this.vaultPath);
        }
        this.clearRememberedKey();
    }
}

export default KeyVault;
