import type { SyncedRecord } from '../../src/types';
import type { ApiFunctions } from '../../src/index';

// ============================================================================
// Test Schema & Data
// ============================================================================

export interface Contact extends SyncedRecord {
    name: string;
    email: string;
    company: string;
    department: string;
    role: string;
    age: number;
    active: boolean;
    country: string;
}

export type BenchmarkSchema = Record<string, Contact> & {
    contacts: Contact;
};

// SQLite structured schema
export const structuredSchema = {
    contacts: {
        columns: {
            name: { type: 'TEXT' as const },
            email: { type: 'TEXT' as const },
            company: { type: 'TEXT' as const },
            department: { type: 'TEXT' as const },
            role: { type: 'TEXT' as const },
            age: { type: 'INTEGER' as const },
            active: { type: 'BOOLEAN' as const },
            country: { type: 'TEXT' as const },
        },
    },
};

// Dexie string schema
export const dexieSchema = {
    contacts: 'name, email, company, department, role, age, active, country',
};

// Dummy APIs - we're not testing sync, just queries
export const dummyApis: Record<string, ApiFunctions> = {
    contacts: {
        add: async () => ({ id: 1, updated_at: new Date().toISOString() }),
        update: async () => true,
        remove: async () => {},
        list: async () => [],
    },
};

const companies = ['Acme Corp', 'TechStart', 'GlobalInc', 'DataFlow', 'CloudNine', 'ByteWorks', 'NetSphere', 'CodeCraft'];
const departments = ['Engineering', 'Sales', 'Marketing', 'Support', 'HR', 'Finance', 'Legal', 'Operations'];
const roles = ['Engineer', 'Manager', 'Director', 'VP', 'Analyst', 'Specialist', 'Coordinator', 'Lead'];
const countries = ['USA', 'UK', 'Germany', 'France', 'Japan', 'Australia', 'Canada', 'Brazil'];

export const generateContacts = (count: number): Omit<Contact, '_localId' | 'updated_at'>[] => {
    const contacts: Omit<Contact, '_localId' | 'updated_at'>[] = [];
    for (let i = 0; i < count; i++) {
        contacts.push({
            name: `Contact ${i}`,
            email: `contact${i}@${companies[i % companies.length]!.toLowerCase().replace(' ', '')}.com`,
            company: companies[i % companies.length]!,
            department: departments[i % departments.length]!,
            role: roles[i % roles.length]!,
            age: 22 + (i % 45),
            active: i % 3 !== 0,
            country: countries[i % countries.length]!,
        });
    }
    return contacts;
};
