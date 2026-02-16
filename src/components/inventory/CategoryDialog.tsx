import { useState, useEffect } from 'react';
import { FolderPlus } from 'lucide-react';
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
import { Category } from '@/types/pos';

interface CategoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (category: Omit<Category, 'id'>) => void;
  category?: Category | null;
}

const colors = [
  { name: 'Blue', value: 'hsl(210 100% 50%)' },
  { name: 'Cyan', value: 'hsl(190 95% 45%)' },
  { name: 'Green', value: 'hsl(152 69% 40%)' },
  { name: 'Yellow', value: 'hsl(38 92% 50%)' },
  { name: 'Purple', value: 'hsl(280 65% 55%)' },
  { name: 'Red', value: 'hsl(0 72% 51%)' },
  { name: 'Pink', value: 'hsl(320 70% 50%)' },
  { name: 'Orange', value: 'hsl(25 95% 55%)' },
];

export const CategoryDialog = ({ isOpen, onClose, onSave, category }: CategoryDialogProps) => {
  const [formData, setFormData] = useState({
    name: '',
    color: 'hsl(210 100% 50%)',
    type: 'physical' as 'physical' | 'service' | 'both',
  });

  useEffect(() => {
    if (category) {
      setFormData({
        name: category.name,
        color: category.color,
        type: category.type || 'physical',
      });
    } else {
      setFormData({
        name: '',
        color: 'hsl(210 100% 50%)',
        type: 'physical',
      });
    }
  }, [category, isOpen]);

  const handleSubmit = () => {
    if (!formData.name) return;
    onSave(formData);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="w-5 h-5" />
            {category ? 'Edit Category' : 'Add Category'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Category Name</Label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., Phone Cases"
            />
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <Select
              value={formData.type}
              onValueChange={(value: 'physical' | 'service' | 'both') => 
                setFormData({ ...formData, type: value })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="physical">Physical Products</SelectItem>
                <SelectItem value="service">Services</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="grid grid-cols-4 gap-2">
              {colors.map((color) => (
                <button
                  key={color.name}
                  type="button"
                  onClick={() => setFormData({ ...formData, color: color.value })}
                  className={`h-10 rounded-lg transition-all ${
                    formData.color === color.value 
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' 
                      : ''
                  }`}
                  style={{ backgroundColor: color.value }}
                  title={color.name}
                />
              ))}
            </div>
          </div>

          <div className="p-4 rounded-lg bg-muted/30">
            <Label className="text-xs text-muted-foreground">Preview</Label>
            <div className="mt-2 flex items-center gap-2">
              <div 
                className="w-3 h-3 rounded-full" 
                style={{ backgroundColor: formData.color }}
              />
              <span className="font-medium">{formData.name || 'Category Name'}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={handleSubmit}
            disabled={!formData.name}
            className="bg-primary hover:bg-primary-hover"
          >
            {category ? 'Save Changes' : 'Add Category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
