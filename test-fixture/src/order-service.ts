import { User, Order, OrderItem } from "./types.js";
import { isAdmin } from "./user-service.js";

export function createOrder(user: User, items: OrderItem[], priority: string = "normal"): Order {
  const total = calculateTotal(items, user);
  return {
    id: Math.random().toString(36).substring(2, 15),
    user,
    items,
    total,
    status: "pending",
  };
}

function calculateTotal(items: OrderItem[], user: User): number {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  // Admins get 10% discount
  if (isAdmin(user)) {
    return subtotal * 0.9;
  }
  return subtotal;
}

export function processOrder(order: Order): Order {
  validateOrder(order);
  return { ...order, status: "processed" };
}

function validateOrder(order: Order): void {
  if (order.items.length === 0) {
    throw new Error("Order must have at least one item");
  }
  if (order.total <= 0) {
    throw new Error("Order total must be positive");
  }
}

export function getOrderSummary(order: Order): string {
  return `Order ${order.id}: ${order.items.length} items, $${order.total.toFixed(2)} (${order.status})`;
}
