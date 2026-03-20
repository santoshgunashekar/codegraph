import { User, UserRole } from "./types.js";

export function createUser(name: string, email: string, role: UserRole = UserRole.MEMBER): User {
  return {
    id: generateId(),
    name,
    email,
    role,
  };
}

export function getUserDisplayName(user: User): string {
  return `${user.name} <${user.email}>`;
}

export function isAdmin(user: User): boolean {
  return user.role === UserRole.ADMIN;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function formatUserForLog(user: User): string {
  return `[${user.role}] ${user.name} (${user.id})`;
}

// This function is intentionally unused
export function deprecatedUserCheck(user: User): boolean {
  return user.email.includes("@old-domain.com");
}
