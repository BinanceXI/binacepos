import { Product, Category, User, ServiceItem, Discount, Sale } from '@/types/pos';

export let categories: Category[] = [
  { id: 'all', name: 'All Items', color: 'hsl(210 100% 50%)', type: 'both' },
  { id: 'accessories', name: 'Accessories', color: 'hsl(210 100% 50%)', type: 'physical' },
  { id: 'cables', name: 'Cables & Chargers', color: 'hsl(190 95% 45%)', type: 'physical' },
  { id: 'satellite', name: 'Satellite Kits', color: 'hsl(152 69% 40%)', type: 'physical' },
  { id: 'repair', name: 'Repairs', color: 'hsl(38 92% 50%)', type: 'service' },
  { id: 'flashing', name: 'Flashing', color: 'hsl(280 65% 55%)', type: 'service' },
  { id: 'installation', name: 'Installation', color: 'hsl(0 72% 51%)', type: 'service' },
  { id: 'media', name: 'Media Loading', color: 'hsl(320 70% 50%)', type: 'service' },
];

// Helper functions for categories
export const addCategory = (category: Category) => {
  categories = [...categories, category];
};

export const removeCategory = (categoryId: string) => {
  categories = categories.filter(c => c.id !== categoryId && c.id !== 'all');
};

export const updateCategory = (categoryId: string, updates: Partial<Category>) => {
  categories = categories.map(c => c.id === categoryId ? { ...c, ...updates } : c);
};

// Physical products (countable stock) with shortcut codes
export let products: Product[] = [
  // Cables & Chargers
  { id: '1', name: 'USB-C Cable 1m', sku: 'CBL001', barcode: '6001234567890', shortcutCode: 'C1', price: 5.00, cost: 2.00, stock: 50, category: 'cables', type: 'physical', lowStockThreshold: 10 },
  { id: '2', name: 'USB-C Cable 2m', sku: 'CBL002', barcode: '6001234567891', shortcutCode: 'C2', price: 7.00, cost: 3.00, stock: 35, category: 'cables', type: 'physical', lowStockThreshold: 10 },
  { id: '3', name: 'Lightning Cable 1m', sku: 'CBL003', barcode: '6001234567892', shortcutCode: 'L1', price: 8.00, cost: 3.50, stock: 40, category: 'cables', type: 'physical', lowStockThreshold: 10 },
  { id: '4', name: 'Micro USB Cable', sku: 'CBL004', barcode: '6001234567893', shortcutCode: 'M1', price: 3.50, cost: 1.50, stock: 60, category: 'cables', type: 'physical', lowStockThreshold: 15 },
  { id: '5', name: 'HDMI Cable 1.5m', sku: 'CBL005', barcode: '6001234567894', shortcutCode: 'H1', price: 12.00, cost: 5.00, stock: 25, category: 'cables', type: 'physical', lowStockThreshold: 5 },
  { id: '6', name: 'Fast Charger 25W', sku: 'CHG001', barcode: '6001234567895', shortcutCode: 'F25', price: 15.00, cost: 7.00, stock: 30, category: 'cables', type: 'physical', lowStockThreshold: 8 },
  { id: '7', name: 'Fast Charger 45W', sku: 'CHG002', barcode: '6001234567896', shortcutCode: 'F45', price: 25.00, cost: 12.00, stock: 20, category: 'cables', type: 'physical', lowStockThreshold: 5 },
  { id: '8', name: 'Car Charger Dual USB', sku: 'CHG003', barcode: '6001234567897', shortcutCode: 'CC', price: 10.00, cost: 4.00, stock: 35, category: 'cables', type: 'physical', lowStockThreshold: 8 },
  
  // Accessories
  { id: '9', name: 'Phone Pouch Universal', sku: 'ACC001', barcode: '6001234567898', shortcutCode: 'PP', price: 8.00, cost: 3.00, stock: 40, category: 'accessories', type: 'physical', lowStockThreshold: 10 },
  { id: '10', name: 'Screen Protector iPhone', sku: 'ACC002', barcode: '6001234567899', shortcutCode: 'SPI', price: 5.00, cost: 1.50, stock: 55, category: 'accessories', type: 'physical', lowStockThreshold: 15 },
  { id: '11', name: 'Screen Protector Samsung', sku: 'ACC003', barcode: '6001234567900', shortcutCode: 'SPS', price: 5.00, cost: 1.50, stock: 50, category: 'accessories', type: 'physical', lowStockThreshold: 15 },
  { id: '12', name: 'Power Bank 10000mAh', sku: 'ACC004', barcode: '6001234567901', shortcutCode: 'PB10', price: 25.00, cost: 12.00, stock: 18, category: 'accessories', type: 'physical', lowStockThreshold: 5 },
  { id: '13', name: 'Power Bank 20000mAh', sku: 'ACC005', barcode: '6001234567902', shortcutCode: 'PB20', price: 40.00, cost: 20.00, stock: 12, category: 'accessories', type: 'physical', lowStockThreshold: 3 },
  { id: '14', name: 'Earbuds Wireless', sku: 'ACC006', barcode: '6001234567903', shortcutCode: 'EBW', price: 35.00, cost: 15.00, stock: 22, category: 'accessories', type: 'physical', lowStockThreshold: 5 },
  { id: '15', name: 'Phone Holder Car', sku: 'ACC007', barcode: '6001234567904', shortcutCode: 'PHC', price: 12.00, cost: 5.00, stock: 28, category: 'accessories', type: 'physical', lowStockThreshold: 8 },
  
  // Satellite Kits
  { id: '16', name: 'DSTV HD Decoder', sku: 'SAT001', barcode: '6001234567905', shortcutCode: 'DHD', price: 65.00, cost: 45.00, stock: 8, category: 'satellite', type: 'physical', lowStockThreshold: 3 },
  { id: '17', name: 'DSTV Explora 3', sku: 'SAT002', barcode: '6001234567906', shortcutCode: 'DE3', price: 150.00, cost: 110.00, stock: 4, category: 'satellite', type: 'physical', lowStockThreshold: 2 },
  { id: '18', name: 'OpenView HD Decoder', sku: 'SAT003', barcode: '6001234567907', shortcutCode: 'OVD', price: 45.00, cost: 30.00, stock: 10, category: 'satellite', type: 'physical', lowStockThreshold: 3 },
  { id: '19', name: 'Starlink Kit Standard', sku: 'SAT004', barcode: '6001234567908', shortcutCode: 'SLK', price: 600.00, cost: 500.00, stock: 2, category: 'satellite', type: 'physical', lowStockThreshold: 1 },
  { id: '20', name: 'Satellite Dish 80cm', sku: 'SAT005', barcode: '6001234567909', shortcutCode: 'SD80', price: 35.00, cost: 20.00, stock: 12, category: 'satellite', type: 'physical', lowStockThreshold: 4 },
  { id: '21', name: 'LNB Single Universal', sku: 'SAT006', barcode: '6001234567910', shortcutCode: 'LNB', price: 8.00, cost: 4.00, stock: 25, category: 'satellite', type: 'physical', lowStockThreshold: 8 },
  { id: '22', name: 'Coaxial Cable 20m', sku: 'SAT007', barcode: '6001234567911', shortcutCode: 'COX', price: 15.00, cost: 8.00, stock: 18, category: 'satellite', type: 'physical', lowStockThreshold: 5 },
  
  // Services (non-countable)
  { id: '23', name: 'Screen Repair - Standard', sku: 'SVC001', shortcutCode: 'SRS', price: 50.00, cost: 0, stock: 999, category: 'repair', type: 'service', lowStockThreshold: 0 },
  { id: '24', name: 'Screen Repair - Premium', sku: 'SVC002', shortcutCode: 'SRP', price: 80.00, cost: 0, stock: 999, category: 'repair', type: 'service', lowStockThreshold: 0 },
  { id: '25', name: 'Battery Replacement', sku: 'SVC003', shortcutCode: 'BR', price: 35.00, cost: 0, stock: 999, category: 'repair', type: 'service', lowStockThreshold: 0 },
  { id: '26', name: 'Phone Flashing', sku: 'SVC004', shortcutCode: 'PF', price: 15.00, cost: 0, stock: 999, category: 'flashing', type: 'service', lowStockThreshold: 0 },
  { id: '27', name: 'Laptop Format & Setup', sku: 'SVC005', shortcutCode: 'LFS', price: 25.00, cost: 0, stock: 999, category: 'flashing', type: 'service', lowStockThreshold: 0 },
  { id: '28', name: 'DSTV Installation', sku: 'SVC006', shortcutCode: 'DI', price: 40.00, cost: 0, stock: 999, category: 'installation', type: 'service', lowStockThreshold: 0 },
  { id: '29', name: 'Starlink Installation', sku: 'SVC007', shortcutCode: 'SI', price: 80.00, cost: 0, stock: 999, category: 'installation', type: 'service', lowStockThreshold: 0 },
  { id: '30', name: 'Movie Loading (per GB)', sku: 'SVC008', shortcutCode: 'ML', price: 2.00, cost: 0, stock: 999, category: 'media', type: 'service', lowStockThreshold: 0 },
  { id: '31', name: 'Music Loading', sku: 'SVC009', shortcutCode: 'MUL', price: 5.00, cost: 0, stock: 999, category: 'media', type: 'service', lowStockThreshold: 0 },
];

// Find product by shortcut code
export const findByShortcut = (code: string): Product | undefined => {
  return products.find(p => p.shortcutCode?.toLowerCase() === code.toLowerCase());
};

// Helper functions for products
export const addProduct = (product: Product) => {
  products = [...products, product];
};

export const removeProduct = (productId: string) => {
  products = products.filter(p => p.id !== productId);
};

export const updateProduct = (productId: string, updates: Partial<Product>) => {
  products = products.map(p => p.id === productId ? { ...p, ...updates } : p);
};

export const adjustStock = (productId: string, adjustment: number) => {
  products = products.map(p => 
    p.id === productId ? { ...p, stock: Math.max(0, p.stock + adjustment) } : p
  );
};

// Service templates for quick add
export const serviceTemplates: ServiceItem[] = [
  { id: 's1', name: 'Screen Repair', basePrice: 50.00, category: 'repair', description: 'Phone/tablet screen replacement' },
  { id: 's2', name: 'Phone Flashing', basePrice: 15.00, category: 'flashing', description: 'Software reinstall and setup' },
  { id: 's3', name: 'Battery Replacement', basePrice: 35.00, category: 'repair', description: 'Battery swap for phones/laptops' },
  { id: 's4', name: 'DSTV Installation', basePrice: 40.00, category: 'installation', description: 'Full satellite dish installation' },
  { id: 's5', name: 'Starlink Setup', basePrice: 80.00, category: 'installation', description: 'Starlink dish install and config' },
  { id: 's6', name: 'Movie Loading', basePrice: 2.00, category: 'media', description: 'Per GB of movies' },
  { id: 's7', name: 'Custom Service', basePrice: 0, category: 'repair', description: 'Enter custom description and price' },
];

// Default users with password authentication
export let users: User[] = [
  { 
    id: '1', 
    name: 'Admin',
    username: 'admin',
    role: 'admin', 
    password: 'admin123',
    active: true,
    permissions: {
      allowRefunds: true,
      allowVoid: true,
      allowPriceEdit: true,
      allowDiscount: true,
      allowReports: true,
      allowInventory: true,
      allowSettings: true,
      allowEditReceipt: true,
    }
  },
  { 
    id: '2', 
    name: 'Cashier',
    username: 'cashier',
    role: 'cashier', 
    password: 'cashier123',
    active: true,
    permissions: {
      allowRefunds: false,
      allowVoid: false,
      allowPriceEdit: false,
      allowDiscount: false,
      allowReports: false,
      allowInventory: false,
      allowSettings: false,
      allowEditReceipt: false,
    }
  },
];

// Helper functions for users
export const addUser = (user: User) => {
  users = [...users, user];
};

export const removeUser = (userId: string) => {
  users = users.filter(u => u.id !== userId);
};

export const updateUser = (userId: string, updates: Partial<User>) => {
  users = users.map(u => u.id === userId ? { ...u, ...updates } : u);
};

// Discounts and Promotions
export let discounts: Discount[] = [
  {
    id: 'd1',
    name: 'Staff Discount',
    type: 'percentage',
    value: 10,
    code: 'STAFF10',
    active: true,
    applicableTo: 'all'
  },
  {
    id: 'd2',
    name: 'Bulk Cable Discount',
    type: 'fixed',
    value: 5,
    minPurchase: 50,
    active: true,
    applicableTo: 'category',
    categoryId: 'cables'
  }
];

export const addDiscount = (discount: Discount) => {
  discounts = [...discounts, discount];
};

export const removeDiscount = (discountId: string) => {
  discounts = discounts.filter(d => d.id !== discountId);
};

export const updateDiscount = (discountId: string, updates: Partial<Discount>) => {
  discounts = discounts.map(d => d.id === discountId ? { ...d, ...updates } : d);
};

// Sales history (mock)
export let salesHistory: Sale[] = [
  {
    id: 'TM001',
    items: [],
    subtotal: 45.00,
    tax: 4.50,
    discount: 0,
    total: 49.50,
    payments: [{ method: 'cash', amount: 49.50 }],
    cashier: users[1],
    cashierId: '2',
    customerName: 'John Doe',
    timestamp: new Date(Date.now() - 1000 * 60 * 30), // 30 mins ago
    status: 'completed',
    synced: true
  },
  {
    id: 'TM002',
    items: [],
    subtotal: 22.00,
    tax: 2.20,
    discount: 0,
    total: 24.20,
    payments: [{ method: 'ecocash', amount: 24.20 }],
    cashier: users[1],
    cashierId: '2',
    customerName: 'Jane Smith',
    timestamp: new Date(Date.now() - 1000 * 60 * 45), // 45 mins ago
    status: 'completed',
    synced: true
  },
  {
    id: 'TM003',
    items: [],
    subtotal: 150.00,
    tax: 15.00,
    discount: 0,
    total: 165.00,
    payments: [{ method: 'card', amount: 165.00 }],
    cashier: users[0],
    cashierId: '1',
    timestamp: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
    status: 'completed',
    synced: true
  }
];

export const addSale = (sale: Sale) => {
  salesHistory = [sale, ...salesHistory];
};

export const getSalesByCashier = (cashierId: string, date?: Date): Sale[] => {
  return salesHistory.filter(sale => {
    const matchesCashier = sale.cashierId === cashierId;
    if (!date) return matchesCashier;
    
    const saleDate = new Date(sale.timestamp);
    return matchesCashier && 
           saleDate.getFullYear() === date.getFullYear() &&
           saleDate.getMonth() === date.getMonth() &&
           saleDate.getDate() === date.getDate();
  });
};

export const getSalesByDate = (date: Date): Sale[] => {
  return salesHistory.filter(sale => {
    const saleDate = new Date(sale.timestamp);
    return saleDate.getFullYear() === date.getFullYear() &&
           saleDate.getMonth() === date.getMonth() &&
           saleDate.getDate() === date.getDate();
  });
};

// Calculate profit for products
export const calculateProfit = (productIds?: string[]): { totalCost: number; totalRevenue: number; totalProfit: number; profitMargin: number } => {
  const targetProducts = productIds 
    ? products.filter(p => productIds.includes(p.id))
    : products.filter(p => p.type === 'physical');
  
  const totalCost = targetProducts.reduce((sum, p) => sum + (p.cost * p.stock), 0);
  const totalRevenue = targetProducts.reduce((sum, p) => sum + (p.price * p.stock), 0);
  const totalProfit = totalRevenue - totalCost;
  const profitMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
  
  return { totalCost, totalRevenue, totalProfit, profitMargin };
};

export const salesSummary = {
  today: {
    total: 1250.50,
    transactions: 28,
    avgTicket: 44.66,
    cash: 680.00,
    card: 320.50,
    ecocash: 250.00,
    repairs: 8,
  },
  week: {
    total: 7850.75,
    transactions: 156,
    avgTicket: 50.32,
  },
  month: {
    total: 32450.00,
    transactions: 642,
    avgTicket: 50.55,
  },
};

export const lowStockProducts = products.filter(p => p.type === 'physical' && p.stock <= p.lowStockThreshold);

export const recentTransactions = [
  { id: 'TM001', time: '10:45 AM', items: 3, total: 45.00, cashier: 'Cashier 1', method: 'Cash', type: 'Repair' },
  { id: 'TM002', time: '10:32 AM', items: 2, total: 22.00, cashier: 'Cashier 1', method: 'EcoCash', type: 'Sale' },
  { id: 'TM003', time: '10:15 AM', items: 1, total: 150.00, cashier: 'Manager', method: 'Card', type: 'Sale' },
  { id: 'TM004', time: '09:58 AM', items: 1, total: 15.00, cashier: 'Cashier 2', method: 'Cash', type: 'Service' },
  { id: 'TM005', time: '09:45 AM', items: 5, total: 68.50, cashier: 'Cashier 1', method: 'EcoCash', type: 'Sale' },
];
