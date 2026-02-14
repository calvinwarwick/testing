#!/bin/bash
# Monitor bot performance for 24-hour test
# Usage: ./scripts/monitor.sh

LOG_FILE="logs/monitor.log"
SESSION_FILE="data/session.json"

echo "=== Bot Monitor Started at $(date) ===" >> $LOG_FILE

while true; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

    # Check if bot is running
    if ! pgrep -f "node dist/index.js" > /dev/null; then
        echo "[$TIMESTAMP] WARNING: Bot not running! Restarting..." >> $LOG_FILE
        SIMULATE_MARKETS=true nohup npm start >> logs/bot-24h.log 2>&1 &
        sleep 10
    fi

    # Read session stats
    if [ -f "$SESSION_FILE" ]; then
        PROFIT=$(cat $SESSION_FILE | jq -r '.totalProfit // 0')
        TRADES=$(cat $SESSION_FILE | jq -r '.totalTradesExecuted // 0')
        PROFITABLE=$(cat $SESSION_FILE | jq -r '.profitableTrades // 0')

        if [ "$TRADES" -gt 0 ]; then
            WIN_RATE=$(echo "scale=1; $PROFITABLE * 100 / $TRADES" | bc)
        else
            WIN_RATE="0.0"
        fi

        echo "[$TIMESTAMP] Profit: \$$PROFIT | Trades: $TRADES | Profitable: $PROFITABLE | Win Rate: ${WIN_RATE}%" >> $LOG_FILE

        # Alert if win rate drops below 50%
        if [ "$TRADES" -ge 10 ]; then
            WIN_PCT=$(echo "$PROFITABLE * 100 / $TRADES" | bc)
            if [ "$WIN_PCT" -lt 50 ]; then
                echo "[$TIMESTAMP] ALERT: Win rate dropped below 50%! Current: ${WIN_RATE}%" >> $LOG_FILE
            fi
        fi
    fi

    # Check every 5 minutes
    sleep 300
done
