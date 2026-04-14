import json
from datamodel import OrderDepth, TradingState, Order


class Trader:
    """
    IMC Prosperity 4 — Tutorial Round
    Products: EMERALDS (stable @ 10000), TOMATOES (volatile, mean-reverting)
    Position limits: 80 each
    """

    def run(self, state: TradingState) -> tuple[dict[str, list[Order]], int, str]:
        result = {}

        # ── Restore persisted state ──
        td = json.loads(state.traderData) if state.traderData else {}

        for product in state.order_depths:
            depth = state.order_depths[product]
            pos = state.position.get(product, 0)

            if product == "EMERALDS":
                result[product] = self.trade_emeralds(depth, pos)
            elif product == "TOMATOES":
                result[product], td = self.trade_tomatoes(depth, pos, td)
            else:
                result[product] = []

        return result, 0, json.dumps(td)

    # ═══════════════════════════════════════════════════
    #  EMERALDS — Stable product, fixed fair value 10000
    # ═══════════════════════════════════════════════════
    def trade_emeralds(self, depth: OrderDepth, pos: int) -> list[Order]:
        """
        EMERALDS has a known fair value of exactly 10000.
        The book is almost always: bid1=9992 / ask1=10008 (spread=16).
        
        Strategy:
        1. TAKE any mispriced orders (buy below 10000, sell above 10000)
        2. QUOTE inside the spread to capture profit from other takers
        """
        orders = []
        FAIR = 10000
        LIMIT = 80

        buy_capacity = LIMIT - pos      # how much more we can buy
        sell_capacity = LIMIT + pos      # how much more we can sell

        # ── 1. TAKE: aggressively grab mispriced orders from the book ──

        # Take cheap asks (buy everything priced below fair value)
        if depth.sell_orders:
            for ask_price in sorted(depth.sell_orders.keys()):
                if ask_price < FAIR and buy_capacity > 0:
                    ask_vol = abs(depth.sell_orders[ask_price])
                    qty = min(ask_vol, buy_capacity)
                    orders.append(Order("EMERALDS", ask_price, qty))
                    buy_capacity -= qty

        # Take expensive bids (sell everything priced above fair value)
        if depth.buy_orders:
            for bid_price in sorted(depth.buy_orders.keys(), reverse=True):
                if bid_price > FAIR and sell_capacity > 0:
                    bid_vol = depth.buy_orders[bid_price]
                    qty = min(bid_vol, sell_capacity)
                    orders.append(Order("EMERALDS", bid_price, -qty))
                    sell_capacity -= qty

        # ── 2. QUOTE: place passive orders inside the spread ──
        # Buy at 9996-9998, sell at 10002-10004 (inside the typical 9992/10008 spread)
        # Skew quotes based on inventory to avoid hitting position limits

        # Inventory skew: if we're long, lower buy price & be more eager to sell
        skew = round(pos * 0.05)

        buy_price = FAIR - 3 - skew     # typically 9997, shifts with inventory
        sell_price = FAIR + 3 - skew    # typically 10003, shifts with inventory

        # Size: fill up remaining capacity, but cap per order
        buy_qty = min(25, buy_capacity)
        sell_qty = min(25, sell_capacity)

        if buy_qty > 0:
            orders.append(Order("EMERALDS", buy_price, buy_qty))
        if sell_qty > 0:
            orders.append(Order("EMERALDS", sell_price, -sell_qty))

        return orders

    # ═══════════════════════════════════════════════════
    #  TOMATOES — Volatile, mean-reverting
    # ═══════════════════════════════════════════════════
    def trade_tomatoes(self, depth: OrderDepth, pos: int, td: dict) -> tuple[list[Order], dict]:
        """
        TOMATOES is volatile (std~20) with strong negative autocorrelation (-0.40).
        This means price moves tend to reverse quickly.
        
        Strategy:
        1. Use Wall Mid (level 2 average) as fair value — more stable than raw mid
        2. Track an EMA for trend awareness
        3. TAKE mispriced orders aggressively
        4. QUOTE around the Wall Mid with inventory-aware skewing
        """
        orders = []
        LIMIT = 80

        buy_capacity = LIMIT - pos
        sell_capacity = LIMIT + pos

        # ── Compute fair value: Wall Mid ──
        # Level 2 typically has the deepest volume (the "walls")
        wall_mid = self.get_wall_mid(depth)
        if wall_mid is None:
            return orders, td

        # ── EMA for smoother fair value tracking ──
        alpha = 0.20
        ema_key = "tom_ema"
        ema = td.get(ema_key, wall_mid)
        ema = alpha * wall_mid + (1 - alpha) * ema
        td[ema_key] = ema

        # Use EMA as our fair value (slightly smoothed wall mid)
        fair = ema

        # ── 1. TAKE: aggressively grab mispriced orders ──
        # Since TOMATOES is mean-reverting, taking mispriced orders is very profitable

        if depth.sell_orders:
            for ask_price in sorted(depth.sell_orders.keys()):
                if ask_price < fair - 1 and buy_capacity > 0:
                    ask_vol = abs(depth.sell_orders[ask_price])
                    qty = min(ask_vol, buy_capacity)
                    orders.append(Order("TOMATOES", ask_price, qty))
                    buy_capacity -= qty

        if depth.buy_orders:
            for bid_price in sorted(depth.buy_orders.keys(), reverse=True):
                if bid_price > fair + 1 and sell_capacity > 0:
                    bid_vol = depth.buy_orders[bid_price]
                    qty = min(bid_vol, sell_capacity)
                    orders.append(Order("TOMATOES", bid_price, -qty))
                    sell_capacity -= qty

        # ── 2. QUOTE: market make around fair value ──
        # Spread of 4 ticks from fair value (inside the typical 13-tick market spread)
        # Inventory skew: shift quotes to reduce position

        skew = round(pos * 0.10)  # more aggressive skew for volatile product

        buy_price = round(fair) - 4 - skew
        sell_price = round(fair) + 4 - skew

        buy_qty = min(20, buy_capacity)
        sell_qty = min(20, sell_capacity)

        if buy_qty > 0:
            orders.append(Order("TOMATOES", buy_price, buy_qty))
        if sell_qty > 0:
            orders.append(Order("TOMATOES", sell_price, -sell_qty))

        return orders, td

    # ═══════════════════════════════════════════════════
    #  UTILITIES
    # ═══════════════════════════════════════════════════
    def get_wall_mid(self, depth: OrderDepth) -> float | None:
        """
        Find the Wall Mid: average of the bid and ask price levels
        with the deepest liquidity (largest volume).
        
        In Prosperity markets, market maker bots typically post large
        "wall" orders that closely track the true fair value.
        """
        if not depth.buy_orders or not depth.sell_orders:
            return None

        # Find bid price with largest volume
        wall_bid = max(depth.buy_orders.items(), key=lambda x: x[1])[0]

        # Find ask price with largest absolute volume (sell volumes are negative)
        wall_ask = min(depth.sell_orders.items(), key=lambda x: x[1])[0]

        return (wall_bid + wall_ask) / 2
