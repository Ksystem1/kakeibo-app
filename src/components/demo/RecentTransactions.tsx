import { Coffee, House, ShoppingBasket } from "lucide-react";

type RecentTransaction = {
  id: number;
  category: string;
  title: string;
  amount: number;
  time: string;
};

type RecentTransactionsProps = {
  items: RecentTransaction[];
  className?: string;
};

function iconForCategory(category: string) {
  if (category.includes("食")) return <ShoppingBasket size={16} />;
  if (category.includes("光熱")) return <House size={16} />;
  return <Coffee size={16} />;
}

export function RecentTransactions({ items, className }: RecentTransactionsProps) {
  return (
    <section
      className={`rounded-2xl border border-slate-200/95 bg-white p-4 shadow-md ring-1 ring-slate-900/[0.04] ${className ?? ""}`}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">最新の支出</h2>
        <button className="text-xs font-semibold text-mint-600">すべて見る</button>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between rounded-xl border border-slate-100/80 bg-slate-100/60 px-3 py-2.5"
          >
            <div className="flex items-center gap-2.5">
              <span className="rounded-full bg-white p-2 text-slate-600 shadow-sm">
                {iconForCategory(item.category)}
              </span>
              <div>
                <p className="text-sm font-medium text-slate-900">{item.title}</p>
                <p className="text-xs text-slate-500">
                  {item.category} ・ {item.time}
                </p>
              </div>
            </div>
            <p className="text-sm font-semibold text-slate-900">
              -¥{item.amount.toLocaleString("ja-JP")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
