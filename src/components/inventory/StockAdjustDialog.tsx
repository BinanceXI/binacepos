import { useState } from 'react';
import { Plus, Minus, Package } from 'lucide-react';
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
import { Product } from '@/types/pos';

interface StockAdjustDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (productId: string, adjustment: number) => void;
  product: Product | null;
}

export const StockAdjustDialog = ({ isOpen, onClose, onSave, product }: StockAdjustDialogProps) => {
  const [adjustment, setAdjustment] = useState(0);
  const [reason, setReason] = useState('');

  const handleSave = () => {
    if (!product || adjustment === 0) return;
    onSave(product.id, adjustment);
    setAdjustment(0);
    setReason('');
    onClose();
  };

  const newStock = product ? Math.max(0, product.stock + adjustment) : 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            Adjust Stock
          </DialogTitle>
        </DialogHeader>

        {product && (
          <div className="space-y-4 py-4">
            <div className="p-4 rounded-lg bg-muted/30">
              <p className="font-medium">{product.name}</p>
              <p className="text-sm text-muted-foreground">SKU: {product.sku}</p>
              <p className="text-sm text-muted-foreground mt-1">
                Current Stock: <span className="font-semibold">{product.stock}</span>
              </p>
            </div>

            <div className="space-y-2">
              <Label>Adjustment</Label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-12 w-12"
                  onClick={() => setAdjustment(prev => prev - 1)}
                >
                  <Minus className="w-5 h-5" />
                </Button>
                <Input
                  type="number"
                  value={adjustment}
                  onChange={(e) => setAdjustment(parseInt(e.target.value) || 0)}
                  className="text-center text-xl font-bold h-12"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-12 w-12"
                  onClick={() => setAdjustment(prev => prev + 1)}
                >
                  <Plus className="w-5 h-5" />
                </Button>
              </div>
            </div>

            <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">New Stock Level:</span>
                <span className="text-2xl font-bold text-primary">{newStock}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Reason (optional)</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g., Stock count, Damage, New delivery..."
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={handleSave}
            disabled={adjustment === 0}
            className="bg-primary hover:bg-primary-hover"
          >
            Adjust Stock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
