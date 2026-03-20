import { User, UserRole, Order } from "./types.js";
import { createUser, getUserDisplayName, formatUserForLog } from "./user-service.js";
import { createOrder, processOrder, getOrderSummary } from "./order-service.js";

export function handleCreateUser(name: string, email: string): User {
  const user = createUser(name, email);
  console.log(`Created user: ${formatUserForLog(user)}`);
  return user;
}

export function handleCreateOrder(user: User, items: { productId: string; quantity: number; price: number }[]): Order {
  console.log(`Creating order for ${getUserDisplayName(user)}`);
  const order = createOrder(user, items, "normal");
  const processed = processOrder(order);
  console.log(getOrderSummary(processed));
  return processed;
}

export function handleAdminAction(user: User): void {
  if (user.role !== UserRole.ADMIN) {
    throw new Error(`User ${getUserDisplayName(user)} is not an admin`);
  }
  console.log(`Admin action by ${formatUserForLog(user)}`);
}
