// Orders destination (docs/CLIENT.md): the live board (and its history view,
// /admin/orders?view=history) and the Requests tab. The shell renders the
// workspace header, subtabs, alert sounds and route focus.
import { useRoute } from '../../lib/router.ts';
import BoardView from './board/BoardView.tsx';
import HistoryView from './board/HistoryView.tsx';
import RequestsView from './requests/RequestsView.tsx';
import './orders.css';

export default function OrdersPage({ tab }: { tab: 'board' | 'requests' }) {
  const { query } = useRoute();
  if (tab === 'requests') return <RequestsView />;
  if (query.get('view') === 'history') return <HistoryView />;
  return <BoardView />;
}
