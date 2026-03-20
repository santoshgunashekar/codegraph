export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export enum UserRole {
  ADMIN = "admin",
  MEMBER = "member",
  GUEST = "guest",
}

export interface Order {
  id: string;
  user: User;
  items: OrderItem[];
  total: number;
  status: string;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}
