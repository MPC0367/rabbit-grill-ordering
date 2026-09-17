// Guest interface copy (menu, cart, visit). Imported for its side effect by
// guest/GuestApp.tsx and by the admin bundle (the menu preview and the kit
// gallery reuse guest components).
import { registerDictionaries } from './index.ts';
import guest from './guest.ts';
import cart from './cart.ts';
import visit from './visit.ts';

registerDictionaries(guest, cart, visit);
