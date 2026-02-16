import { useState, useEffect } from 'react';
import { Package, Barcode, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Product, Category } from '@/types/pos';
import { categories } from '@/data/mockData';

interface ProductDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (product: Omit<Product, 'id'>) => void;
  product?: Product | null;
}

export const ProductDialog = ({ isOpen, onClose, onSave, product }: ProductDialogProps) => {
  const [formData, setFormData] = useState({
    name: '',
    sku: '',
    barcode: '',
    price: 0,
    cost: 0,
    stock: 0,
    category: 'accessories',
    type: 'physical' as 'physical' | 'service',
    lowStockThreshold: 10,
  });

  useEffect(() => {
    if (product) {
      setFormData({
        name: product.name,
        sku: product.sku,
        barcode: product.barcode || '',
        price: product.price,
        cost: product.cost,
        stock: product.stock,
        category: product.category,
        type: product.type || 'physical',
        lowStockThreshold: product.lowStockThreshold,
      });
    } else {
      setFormData({
        name: '',
        sku: `SKU${Date.now().toString().slice(-6)}`,
        barcode: '',
        price: 0,
        cost: 0,
        stock: 0,
        category: 'accessories',
        type: 'physical',
        lowStockThreshold: 10,
      });
    }
  }, [product, isOpen]);

  const handleSubmit = () => {
    if (!formData.name || formData.price <= 0) return;
    
    onSave({
      name: formData.name,
      sku: formData.sku,
      barcode: formData.barcode || undefined,
      price: formData.price,
      cost: formData.cost,
      stock: formData.type === 'service' ? 999 : formData.stock,
      category: formData.category,
      type: formData.type,
      lowStockThreshold: formData.type === 'service' ? 0 : formData.lowStockThreshold,
    });
    onClose();
  };

  const physicalCategories = categories.filter(c => c.type === 'physical' || c.type === 'both');
  const serviceCategories = categories.filter(c => c.type === 'service' || c.type === 'both');

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            {product ? 'Edit Product' : 'Add New Product'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Product Type</Label>
              <Select
                value={formData.type}
                onValueChange={(value: 'physical' | 'service') => 
                  setFormData({ ...formData, type: value, category: value === 'service' ? 'repair' : 'accessories' })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="physical">Physical Product</SelectItem>
                  <SelectItem value="service">Service</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={formData.category}
                onValueChange={(value) => setFormData({ ...formData, category: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(formData.type === 'physical' ? physicalCategories : serviceCategories)
                    .filter(c => c.id !== 'all')
                    .map(cat => (
                      <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                    ))
                  }
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Product Name</Label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., USB-C Cable 1m"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>SKU</Label>
              <Input
                value={formData.sku}
                onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                placeholder="CBL001"
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                <Barcode className="w-3 h-3" />
                Barcode
              </Label>
              <Input
                value={formData.barcode}
                onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                placeholder="6001234567890"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                Cost Price
              </Label>
              <Input
                type="number"
                step="0.01"
                value={formData.cost}
                onChange={(e) => setFormData({ ...formData, cost: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                Selling Price
              </Label>
              <Input
                type="number"
                step="0.01"
                value={formData.price}
                onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>

          {formData.type === 'physical' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Initial Stock</Label>
                <Input
                  type="number"
                  value={formData.stock}
                  onChange={(e) => setFormData({ ...formData, stock: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <Label>Low Stock Threshold</Label>
                <Input
                  type="number"
                  value={formData.lowStockThreshold}
                  onChange={(e) => setFormData({ ...formData, lowStockThreshold: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={handleSubmit}
            disabled={!formData.name || formData.price <= 0}
            className="bg-primary hover:bg-primary-hover"
          >
            {product ? 'Save Changes' : 'Add Product'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
