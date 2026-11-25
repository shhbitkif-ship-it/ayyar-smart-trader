package com.ayyar.smarttrader

import android.os.Bundle
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

data class QuoteUi(val symbol:String,val name:String,val price:String,val unit:String,val source:String,val status:String,val timestamp:String)
data class HistoryPoint(val date:String,val value:Double)
data class HistoryUi(val symbol:String,val points:List<HistoryPoint>,val note:String)
data class IndicatorUi(val ema20:Double,val ema50:Double,val rsi14:Double,val macd:Double,val signal:Double,val histogram:Double)
data class SignalUi(val signal:String,val confidence:Int,val trend:String,val entry:String,val stop:String,val target:String,val lastCandle:String,val status:String,val reason:String,val timeframes:String,val regime:String,val regimeReason:String,val qualityStatus:String,val qualityReasons:String,val qualityProgress:String)
data class BacktestUi(val interval:String,val candleCount:Int,val startingCapital:Double,val finalEquity:Double,val netReturnPct:Double,val maxDrawdownPct:Double,val closedTrades:Int,val winRatePct:Double,val profitFactor:String,val lastCandle:String,val warning:String)
data class SignalHistoryRow(val signal:String,val trend:String,val confidence:Int,val recordedAt:String,val lastCandle:String,val entry:String,val stop:String,val target:String)
data class CompareRow(val interval:String,val fast:Int,val slow:Int,val returnPct:Double,val drawdownPct:Double,val trades:Int,val winRate:Double,val status:String)
data class WalkForwardFold(val fold:Int,val strategy:String,val testStart:String,val testEnd:String,val returnPct:Double,val drawdownPct:Double,val trades:Int,val winRate:Double)
data class WalkForwardUi(val totalReturnPct:Double,val worstDrawdownPct:Double,val totalTrades:Int,val winRate:Double,val folds:List<WalkForwardFold>)
data class MarketDataHealthUi(val status:String,val quality:String,val provider:String,val interval:String,val candleCount:Int,val ageSeconds:Long,val gapCount:Int,val missingIntervals:Int,val largestGap:Int,val lastCandle:String,val note:String)
data class PaperMonitorStatusUi(val status:String,val provider:String,val interval:String,val accountsChecked:Int,val tradesProcessed:Int,val closedTrades:Int,val candleAt:String,val completedAt:String,val error:String,val mode:String)
data class SignalPerformanceHorizon(val horizon:Int,val scored:Int,val wins:Int,val losses:Int,val flats:Int,val winRate:Double?,val averageReturn:Double?,val averageFavorable:Double?,val averageAdverse:Double?)
data class SignalPerformanceUi(val horizons:List<SignalPerformanceHorizon>,val directionalSignals:Int,val pending:Int,val unavailable:Int,val lastCandle:String,val warning:String)
private val bg=Color(0xFF090B10); private val panel=Color(0xFF171B24); private val gold=Color(0xFFD6AD55); private val muted=Color(0xFF9AA3B2)
private val historySymbols=listOf("gold-18k" to "طلای ۱۸ عیار","gold-24k" to "طلای ۲۴ عیار","gold-mesghal" to "مثقال طلا","coin-emami" to "سکه امامی","coin-half" to "نیم سکه","coin-quarter" to "ربع سکه","usd" to "دلار آزاد","xau" to "اونس جهانی")

class MainActivity:ComponentActivity(){ override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);setContent { AyyarApp() }} }

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun AyyarApp(){
 var refresh by remember { mutableIntStateOf(0) }
 var historyRefresh by remember { mutableIntStateOf(0) }
 var selectedSymbol by remember { mutableStateOf("gold-18k") }
 var backtestRefresh by remember { mutableIntStateOf(0) }
 var backtestInterval by remember { mutableStateOf("60m") }
 var backtestFast by remember { mutableIntStateOf(20) }
 var backtestSlow by remember { mutableIntStateOf(50) }
 var archiveRefresh by remember { mutableIntStateOf(0) }
 var compareRefresh by remember { mutableIntStateOf(0) }
 var walkForwardRefresh by remember { mutableIntStateOf(0) }
 var performanceRefresh by remember { mutableIntStateOf(0) }
 LaunchedEffect(Unit) { while (true) { delay(60000); refresh++ } }
 val snapshot by produceState<Result<List<QuoteUi>>?>(null, refresh) { value = runCatching { withContext(Dispatchers.IO) { fetchQuotes() } } }
 val marketHealth by produceState<Result<MarketDataHealthUi>?>(null, refresh) { value=runCatching { withContext(Dispatchers.IO) { fetchMarketDataHealth() } } }
 val paperMonitor by produceState<Result<PaperMonitorStatusUi>?>(null, refresh) { value=runCatching { withContext(Dispatchers.IO) { fetchPaperMonitorStatus() } } }
 val signal by produceState<Result<SignalUi>?>(null, refresh) { value = runCatching { withContext(Dispatchers.IO) { fetchLatestSignal() } } }
 val history by produceState<Result<HistoryUi>?>(null, selectedSymbol, historyRefresh) { value=runCatching { withContext(Dispatchers.IO) { fetchHistory(selectedSymbol) } } }
 val backtest by produceState<Result<BacktestUi>?>(null, backtestRefresh,backtestInterval,backtestFast,backtestSlow) { if(backtestRefresh>0) value=runCatching { withContext(Dispatchers.IO) { fetchLiveBacktest(backtestInterval,backtestFast,backtestSlow) } } }
 val archivedSignals by produceState<Result<List<SignalHistoryRow>>?>(null, archiveRefresh) { if(archiveRefresh>0) value=runCatching { withContext(Dispatchers.IO) { fetchSignalHistory() } } }
 val comparison by produceState<Result<List<CompareRow>>?>(null, compareRefresh) { if(compareRefresh>0) value=runCatching { withContext(Dispatchers.IO) { fetchBacktestComparison() } } }
 val walkForward by produceState<Result<WalkForwardUi>?>(null, walkForwardRefresh) { if(walkForwardRefresh>0) value=runCatching { withContext(Dispatchers.IO) { fetchWalkForward() } } }
 val performance by produceState<Result<SignalPerformanceUi>?>(null, performanceRefresh) { if(performanceRefresh>0) value=runCatching { withContext(Dispatchers.IO) { fetchSignalPerformance() } } }
 MaterialTheme { Surface(Modifier.fillMaxSize(),color=bg){ LazyColumn(Modifier.fillMaxSize().padding(18.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
   item { Text("عیار هوشمند",color=gold,fontSize=28.sp,fontWeight=FontWeight.Bold); Text("Ayyar Smart Trader  •  نسخه 0.9.5",color=muted,fontSize=12.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("وضعیت داده‌های بازار",color=muted); when { snapshot==null -> Text("در حال اتصال به سرور…",color=Color.White); snapshot!!.isFailure -> Text("سرور هنوز در دسترس نیست؛ قیمت ساختگی نمایش داده نمی‌شود.",color=Color(0xFFFFB86B)); else -> if (snapshot!!.getOrThrow().any { it.status=="LIVE" }) Text("قیمت‌های تازه دریافت شد",color=Color(0xFF8FD6A8)) else Text("اتصال برقرار است؛ فعلاً قیمت زنده معتبر در دسترس نیست.",color=Color(0xFFFFB86B)) }
      Button(onClick={refresh++},colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text("به‌روزرسانی قیمت‌ها")}
   } } }
   item { MarketDataHealthCard(marketHealth) }
   item { PaperMonitorHealthCard(paperMonitor) }
   item { PaperAccountCard() }
   if(snapshot?.isSuccess==true){ items(snapshot!!.getOrThrow()){ q -> QuoteCard(q) } }
   item { Text("تاریخچه و نمودار روزانه",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(14.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
      var expanded by remember { mutableStateOf(false) }
      ExposedDropdownMenuBox(expanded=expanded,onExpandedChange={expanded=it}) {
        OutlinedTextField(value=historySymbols.first{it.first==selectedSymbol}.second,onValueChange={},readOnly=true,label={Text("بازار")},modifier=Modifier.fillMaxWidth().menuAnchor())
        ExposedDropdownMenu(expanded=expanded,onDismissRequest={expanded=false}) { historySymbols.forEach { (id,label) -> DropdownMenuItem(text={Text(label)},onClick={selectedSymbol=id;expanded=false}) } }
      }
      when {
        history==null -> Text("در حال دریافت تاریخچه…",color=muted)
        history!!.isFailure -> Text("تاریخچه فعلاً دریافت نشد. اتصال یا پاسخ منبع داده را بررسی می‌کنم.",color=Color(0xFFFFB86B))
        history!!.getOrThrow().points.isEmpty() -> Text("داده تاریخی قابل‌نمایش در پاسخ منبع پیدا نشد؛ عددی ساخته نشده است.",color=Color(0xFFFFB86B))
        else -> {
          val h=history!!.getOrThrow()
          Text("${h.points.size} نقطه روزانه • ${h.points.first().date} تا ${h.points.last().date}",color=muted,fontSize=11.sp)
          HistoryChart(h.points)
          val indicators = remember(h.points) { calculateIndicators(h.points.map { it.value }) }
          Text("شاخص‌های تکنیکال روزانه",color=gold,fontWeight=FontWeight.Bold,fontSize=14.sp)
          if (indicators == null) {
            Text("برای محاسبه شاخص‌ها حداقل ۵۰ نقطه معتبر لازم است.",color=Color(0xFFFFB86B),fontSize=12.sp)
          } else {
            IndicatorRow("EMA 20",indicators.ema20)
            IndicatorRow("EMA 50",indicators.ema50)
            IndicatorRow("RSI 14",indicators.rsi14,2)
            IndicatorRow("MACD",indicators.macd,4)
            IndicatorRow("خط سیگنال MACD",indicators.signal,4)
            IndicatorRow("هیستوگرام MACD",indicators.histogram,4)
            Text("محاسبات بر اساس میانگین‌های روزانه منبع انجام شده‌اند؛ این شاخص‌ها به‌تنهایی سیگنال خرید یا فروش نیستند.",color=muted,fontSize=10.sp)
          }
          val first=h.points.first().value; val last=h.points.last().value
          val change=if(first!=0.0) (last-first)/first*100 else 0.0
          Text("تغییر بازه: ${String.format(Locale.US,"%.2f",change)}٪",color=if(change>=0) Color(0xFF8FD6A8) else Color(0xFFFF8D8D),fontWeight=FontWeight.Bold)
          h.points.takeLast(7).reversed().forEach { p -> Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(p.date,color=muted,fontSize=12.sp);Text(String.format(Locale.US,"%,.2f",p.value),color=Color.White,fontSize=12.sp)} }
          Text(h.note,color=muted,fontSize=10.sp)
        }
      }
      OutlinedButton(onClick={historyRefresh++},modifier=Modifier.fillMaxWidth()){Text("تازه‌سازی تاریخچه")}
   } } }
   item { Text("سوابق سیگنال‌های ذخیره‌شده",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("آرشیو سیگنال‌های چندتایم‌فریمی اونس جهانی",color=Color.White,fontWeight=FontWeight.SemiBold)
      Text("ثبت بر اساس کندل بسته‌شده • نگهداری ۹۰ روزه • بدون اجرای سفارش",color=muted,fontSize=11.sp)
      when {
        archiveRefresh==0 -> Text("برای مشاهده سوابق، دکمه دریافت تاریخچه را بزن.",color=muted,fontSize=12.sp)
        archivedSignals==null -> Text("در حال دریافت سوابق…",color=muted)
        archivedSignals!!.isFailure -> Text("تاریخچه فعلاً در دسترس نیست.",color=Color(0xFFFFB86B),fontSize=12.sp)
        archivedSignals!!.getOrThrow().isEmpty() -> Text("هنوز سابقه‌ای ثبت نشده است؛ پس از ارزیابی موفق بازار ذخیره می‌شود.",color=muted,fontSize=12.sp)
        else -> archivedSignals!!.getOrThrow().take(20).forEach { row ->
          Column(Modifier.fillMaxWidth().padding(vertical=5.dp),verticalArrangement=Arrangement.spacedBy(3.dp)){
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
              Text(when(row.signal){"BUY"->"خرید";"SELL"->"فروش";else->"عدم معامله"},color=if(row.signal=="BUY") Color(0xFF8FD6A8) else if(row.signal=="SELL") Color(0xFFFF8D8D) else muted,fontWeight=FontWeight.Bold)
              Text("امتیاز ${row.confidence}",color=muted,fontSize=11.sp)
            }
            Text("روند: ${row.trend} • ثبت: ${formatLocalTimestamp(row.recordedAt)}",color=muted,fontSize=10.sp)
            if(row.entry.isNotBlank()) Text("ورود ${row.entry} | حدضرر ${row.stop} | هدف ${row.target}",color=Color.White,fontSize=11.sp)
          }
          Divider(color=Color(0xFF303746))
        }
      }
      OutlinedButton(onClick={archiveRefresh++},modifier=Modifier.fillMaxWidth()){Text("دریافت تاریخچه سیگنال‌ها")}
   } } }
   item { Text("کارنامه واقعی سیگنال‌ها",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("ارزیابی پس از صدور سیگنال با کندل‌های بسته‌شده",color=Color.White,fontWeight=FontWeight.SemiBold)
      Text("ورود فرضی در قیمت بازشدن کندل بعدی؛ افق‌های ۱، ۴ و ۲۴ کندلی",color=muted,fontSize=11.sp)
      when {
        performanceRefresh==0 -> Text("برای محاسبه نتایج واقعی سیگنال‌های آرشیوشده، دکمه زیر را بزن.",color=muted,fontSize=12.sp)
        performance==null -> Text("در حال ارزیابی نتایج سیگنال‌ها…",color=muted)
        performance!!.isFailure -> Text("کارنامه فعلاً قابل محاسبه نیست؛ داده کندل یا آرشیو در دسترس نیست.",color=Color(0xFFFFB86B),fontSize=12.sp)
        else -> {
          val p=performance!!.getOrThrow()
          val maximumScoredSamples=p.horizons.maxOfOrNull { it.scored } ?: 0
          Text("سیگنال جهت‌دار: ${p.directionalSignals} • در انتظار تکمیل: ${p.pending} • غیرقابل ارزیابی: ${p.unavailable}",color=muted,fontSize=11.sp)
          Text(
            when {
              maximumScoredSamples==0 -> "هنوز هیچ نتیجه بالغ و قابل ارزیابی ثبت نشده است؛ درصد برد نمایش داده نمی‌شود."
              maximumScoredSamples<30 -> "نمونه‌ها فعلاً محدود است: حداکثر $maximumScoredSamples نتیجه. برای نمایش زمینه‌ای حداقل ۳۰ نتیجه لازم است."
              else -> "تعداد نتایج به آستانه زمینه‌ای ۳۰ رسیده؛ این عدد به‌تنهایی اعتبار آماری یا سودآوری را ثابت نمی‌کند."
            },
            color=Color(0xFFFFB86B),fontSize=11.sp
          )
          p.horizons.forEach { h ->
            Text("پس از ${h.horizon} کندل",color=gold,fontWeight=FontWeight.SemiBold,fontSize=13.sp)
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
              Text("نمونه: ${h.scored} • برد: ${h.wins} • باخت: ${h.losses}",color=muted,fontSize=11.sp)
              Text(if(h.winRate==null) "—" else String.format(Locale.US,"%.1f%%",h.winRate),color=Color.White,fontSize=11.sp)
            }
            if(h.averageReturn!=null) {
              IndicatorRow("میانگین بازده",h.averageReturn)
              IndicatorRow("میانگین حرکت مطلوب",h.averageFavorable?:0.0)
              IndicatorRow("میانگین حرکت نامطلوب",h.averageAdverse?:0.0)
            }
          }
          Text("آخرین کندل ارزیابی: ${formatLocalTimestamp(p.lastCandle)}",color=muted,fontSize=10.sp)
          Text(p.warning,color=muted,fontSize=10.sp)
        }
      }
      OutlinedButton(onClick={performanceRefresh++},modifier=Modifier.fillMaxWidth()){Text(if(performanceRefresh==0) "محاسبه کارنامه سیگنال‌ها" else "به‌روزرسانی کارنامه")}
   } } }
   item { Text("ارزیابی عملکرد استراتژی با داده واقعی",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("بک‌تست EMA روی کندل‌های بسته‌شده اونس جهانی",color=Color.White,fontWeight=FontWeight.SemiBold)
      Text("تایم‌فریم و پارامترها را تغییر بده؛ هر اجرا فقط داده XAUS را بررسی می‌کند.",color=muted,fontSize=11.sp)
      var intervalExpanded by remember { mutableStateOf(false) }
      ExposedDropdownMenuBox(expanded=intervalExpanded,onExpandedChange={intervalExpanded=it}) {
        OutlinedTextField(value=when(backtestInterval){"15m"->"۱۵ دقیقه";"1d"->"روزانه";else->"۶۰ دقیقه"},onValueChange={},readOnly=true,label={Text("تایم‌فریم")},modifier=Modifier.fillMaxWidth().menuAnchor())
        ExposedDropdownMenu(expanded=intervalExpanded,onDismissRequest={intervalExpanded=false}) {
          listOf("15m" to "۱۵ دقیقه","60m" to "۶۰ دقیقه","1d" to "روزانه").forEach{(id,label)->DropdownMenuItem(text={Text(label)},onClick={backtestInterval=id;intervalExpanded=false})}
        }
      }
      Text("EMA سریع: $backtestFast",color=Color.White,fontSize=12.sp)
      Slider(value=backtestFast.toFloat(),onValueChange={backtestFast=it.toInt().coerceIn(3,backtestSlow-1)},valueRange=3f..59f,steps=55)
      Text("EMA کند: $backtestSlow",color=Color.White,fontSize=12.sp)
      Slider(value=backtestSlow.toFloat(),onValueChange={backtestSlow=it.toInt().coerceIn(backtestFast+1,100)},valueRange=4f..100f,steps=95)
      Text("ریسک ثابت ۱٪ • سرمایه فرضی ۱۰٬۰۰۰ • کارمزد ۱۰ و لغزش ۵ واحد پایه در هر سمت",color=muted,fontSize=10.sp)
      when {
        backtestRefresh==0 -> Text("برای دریافت داده واقعی و اجرای آزمون، دکمه زیر را بزن.",color=muted,fontSize=12.sp)
        backtest==null -> Text("در حال دریافت کندل‌ها و اجرای بک‌تست…",color=muted)
        backtest!!.isFailure -> Text("بک‌تست انجام نشد؛ منبع OHLC در دسترس نیست یا داده معتبر کافی ندارد.",color=Color(0xFFFFB86B),fontSize=12.sp)
        else -> {
          val b=backtest!!.getOrThrow()
          Text("بازده خالص: ${String.format(Locale.US,"%.2f",b.netReturnPct)}٪",color=if(b.netReturnPct>=0) Color(0xFF8FD6A8) else Color(0xFFFF8D8D),fontSize=22.sp,fontWeight=FontWeight.Bold)
          IndicatorRow("سرمایه اولیه",b.startingCapital)
          IndicatorRow("ارزش نهایی",b.finalEquity)
          IndicatorRow("حداکثر افت سرمایه",b.maxDrawdownPct)
          IndicatorRow("تعداد معاملات بسته‌شده",b.closedTrades.toDouble(),0)
          IndicatorRow("درصد معاملات موفق",b.winRatePct)
          Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Profit Factor",color=muted,fontSize=12.sp);Text(b.profitFactor,color=Color.White,fontSize=12.sp)}
          Text("${b.candleCount} کندل • XAUS • ${b.interval} • آخرین کندل: ${formatLocalTimestamp(b.lastCandle)}",color=muted,fontSize=10.sp)
          Text(b.warning,color=muted,fontSize=10.sp)
        }
      }
      Button(onClick={backtestRefresh++},modifier=Modifier.fillMaxWidth(),colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text(if(backtestRefresh==0) "اجرای بک‌تست با داده زنده" else "اجرای دوباره بک‌تست")}
   } } }
   item { Text("مقایسه استراتژی‌ها و تایم‌فریم‌ها",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("EMA 9/21 • EMA 12/26 • EMA 20/50",color=Color.White,fontWeight=FontWeight.SemiBold)
      Text("مقایسه روی کندل‌های واقعی ۱۵، ۳۰ و ۶۰ دقیقه و روزانه؛ سرمایه فرضی و هزینه یکسان",color=muted,fontSize=11.sp)
      when {
        compareRefresh==0 -> Text("برای مقایسه عملکرد تاریخی، دکمه اجرا را بزن.",color=muted,fontSize=12.sp)
        comparison==null -> Text("در حال دریافت داده و اجرای ۱۲ آزمون…",color=muted)
        comparison!!.isFailure -> Text("مقایسه فعلاً انجام نشد؛ داده معتبر کافی دریافت نشد.",color=Color(0xFFFFB86B),fontSize=12.sp)
        comparison!!.getOrThrow().isEmpty() -> Text("نتیجه قابل‌مقایسه‌ای موجود نیست.",color=muted)
        else -> comparison!!.getOrThrow().forEach { row ->
          Column(Modifier.fillMaxWidth().padding(vertical=4.dp),verticalArrangement=Arrangement.spacedBy(3.dp)){
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
              Text("${row.interval} • EMA ${row.fast}/${row.slow}",color=Color.White,fontWeight=FontWeight.SemiBold,fontSize=12.sp)
              Text(if(row.status=="OK") "${String.format(Locale.US,"%.2f",row.returnPct)}٪" else "ناموجود",color=if(row.returnPct>=0) Color(0xFF8FD6A8) else Color(0xFFFF8D8D),fontSize=12.sp)
            }
            if(row.status=="OK") Text("افت سرمایه ${String.format(Locale.US,"%.2f",row.drawdownPct)}٪ • ${row.trades} معامله • موفقیت ${String.format(Locale.US,"%.1f",row.winRate)}٪",color=muted,fontSize=10.sp)
          }
          Divider(color=Color(0xFF303746))
        }
      }
      Button(onClick={compareRefresh++},modifier=Modifier.fillMaxWidth(),colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text("مقایسه استراتژی‌ها")}
      Text("تعداد کندل‌ها و طول نمونه در تایم‌فریم‌ها متفاوت است؛ این نتایج پیش‌بینی آینده نیستند و اجرای سفارش غیرفعال است.",color=muted,fontSize=10.sp)
   } } }
   item { Text("آزمون خارج از نمونه Walk-forward",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("انتخاب استراتژی با داده‌های گذشته و ارزیابی روی بازه‌های بعدیِ دیده‌نشده",color=Color.White,fontWeight=FontWeight.SemiBold)
      Text("سه مرحله ارزیابی روی کندل‌های واقعی ۶۰ دقیقه‌ای؛ حداقل ۱۸۰ کندل لازم است.",color=muted,fontSize=11.sp)
      when {
        walkForwardRefresh==0 -> Text("برای اجرای آزمون مستقل، دکمه زیر را بزن.",color=muted,fontSize=12.sp)
        walkForward==null -> Text("در حال دریافت داده و اجرای سه مرحله آزمون…",color=muted)
        walkForward!!.isFailure -> Text("آزمون انجام نشد؛ داده معتبر کافی از منبع دریافت نشد.",color=Color(0xFFFFB86B),fontSize=12.sp)
        else -> {
          val w=walkForward!!.getOrThrow()
          Text("بازده ترکیبی خارج از نمونه: ${String.format(Locale.US,"%.2f",w.totalReturnPct)}٪",color=if(w.totalReturnPct>=0) Color(0xFF8FD6A8) else Color(0xFFFF8D8D),fontSize=20.sp,fontWeight=FontWeight.Bold)
          IndicatorRow("بدترین افت سرمایه در یک مرحله",w.worstDrawdownPct)
          IndicatorRow("مجموع معاملات بسته‌شده",w.totalTrades.toDouble(),0)
          IndicatorRow("درصد برد کل",w.winRate)
          w.folds.forEach { fold ->
            Column(Modifier.fillMaxWidth().padding(vertical=4.dp),verticalArrangement=Arrangement.spacedBy(3.dp)){
              Text("مرحله ${fold.fold} • ${fold.strategy}",color=Color.White,fontWeight=FontWeight.SemiBold,fontSize=12.sp)
              Text("بازده ${String.format(Locale.US,"%.2f",fold.returnPct)}٪ • افت ${String.format(Locale.US,"%.2f",fold.drawdownPct)}٪ • ${fold.trades} معامله • برد ${String.format(Locale.US,"%.1f",fold.winRate)}٪",color=muted,fontSize=10.sp)
              Text("${formatLocalTimestamp(fold.testStart)} تا ${formatLocalTimestamp(fold.testEnd)}",color=muted,fontSize=10.sp)
            }
            Divider(color=Color(0xFF303746))
          }
        }
      }
      Button(onClick={walkForwardRefresh++},modifier=Modifier.fillMaxWidth(),colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text("اجرای آزمون خارج از نمونه")}
      Text("این آزمون تضمین سود نیست؛ داده آموزشی در سود و زیان دوره آزمون وارد نمی‌شود و سفارش واقعی اجرا نمی‌شود.",color=muted,fontSize=10.sp)
   } } }
   item { Text("مدیریت سرمایه و کنترل ریسک",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { RiskCalculator() }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("موتور تحلیل اونس جهانی طلا • هم‌ترازی چندتایم‌فریمی",color=gold,fontWeight=FontWeight.Bold)
      when {
        signal==null -> Text("در حال دریافت کندل‌های واقعی و ارزیابی بازار…",color=muted)
        signal!!.isFailure -> Text("دریافت سیگنال ناموفق بود؛ تا دریافت داده معتبر معامله‌ای پیشنهاد نمی‌شود.",color=Color(0xFFFFB86B))
        else -> {
          val s=signal!!.getOrThrow()
          Text(when(s.signal){"BUY"->"سیگنال خرید";"SELL"->"سیگنال فروش";else->"بدون معامله"},color=when(s.signal){"BUY"->Color(0xFF8FD6A8);"SELL"->Color(0xFFFF8D8D);else->Color(0xFFFFB86B)},fontSize=22.sp,fontWeight=FontWeight.Bold)
          Text("وضعیت داده: ${s.status}  •  روند ۶۰ دقیقه: ${s.trend}  •  امتیاز هم‌ترازی: ${s.confidence}/100",color=muted,fontSize=11.sp)
          Text("کنترل کیفیت سیگنال: ${s.qualityStatus}  •  ${s.qualityProgress}",color=if(s.qualityStatus=="PASSED") Color(0xFF8FD6A8) else Color(0xFFFFB86B),fontWeight=FontWeight.SemiBold,fontSize=12.sp)
          Text("رژیم بازار ۶۰ دقیقه: ${s.regime}",color=if(s.regime=="TRENDING") Color(0xFF8FD6A8) else Color(0xFFFFB86B),fontWeight=FontWeight.SemiBold,fontSize=12.sp)
          Text(s.regimeReason,color=muted,fontSize=10.sp)
          Text("وضعیت تایم‌فریم‌ها: ${s.timeframes}",color=muted,fontSize=11.sp)
          if(s.qualityReasons.isNotBlank()) Text("دلایل عدم تأیید: ${s.qualityReasons}",color=Color(0xFFFFB86B),fontSize=11.sp)
          if(s.signal!="NO_TRADE"){
            IndicatorRow("نقطه ورود",s.entry.toDoubleOrNull()?:Double.NaN,2)
            IndicatorRow("حد ضرر",s.stop.toDoubleOrNull()?:Double.NaN,2)
            IndicatorRow("حد سود",s.target.toDoubleOrNull()?:Double.NaN,2)
          }
          Text(s.reason,color=muted,fontSize=11.sp)
          Text("آخرین کندل بسته‌شده: ${formatLocalTimestamp(s.lastCandle)}",color=muted,fontSize=10.sp)
        }
      }
      Text("منبع کندل: XAUS (XAU/USD). فقط اونس جهانی؛ برای طلای ۱۸ عیار و سکه ایران هنوز فید OHLC مستقل و معتبر متصل نشده است. امتیاز همگرایی احتمال موفقیت نیست. اجرای سفارش واقعی غیرفعال است.",color=muted,fontSize=11.sp)
   } } }
   item { Text("منبع و زمان به‌روزرسانی کنار هر قیمت درج شده است. داده‌های شاخصی جایگزین قیمت اجرایی کارگزاری نیستند؛ تا زمان اتصال و آزمون داده کندلی درون‌روزی، سیگنال نوسان‌گیری و اجرای معامله غیرفعال می‌ماند.",color=muted,fontSize=11.sp) }
 } } }
}

@Composable private fun HistoryChart(points:List<HistoryPoint>){
 val values=points.map{it.value}; val low=values.minOrNull()?:0.0; val high=values.maxOrNull()?:1.0
 Canvas(Modifier.fillMaxWidth().height(150.dp).background(Color(0xFF10141C),RoundedCornerShape(12.dp)).padding(8.dp)){
   if(points.size>1 && high>low){
     val path=Path()
     points.forEachIndexed { i,p ->
       val x=size.width*i/(points.size-1).toFloat()
       val y=size.height-((p.value-low)/(high-low)).toFloat()*size.height
       if(i==0) path.moveTo(x,y) else path.lineTo(x,y)
     }
     drawPath(path,color=gold,style=androidx.compose.ui.graphics.drawscope.Stroke(width=3.dp.toPx()))
   }
 }
}

@Composable private fun QuoteCard(q:QuoteUi){
 Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(16.dp)){ Column(Modifier.fillMaxWidth().padding(14.dp),verticalArrangement=Arrangement.spacedBy(5.dp)){
   Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){ Text(q.name,color=Color.White,fontWeight=FontWeight.SemiBold); Text(q.status,color=if(q.status=="LIVE") Color(0xFF8FD6A8) else Color(0xFFFFB86B),fontSize=11.sp) }
   Text(q.price,color=gold,fontSize=23.sp,fontWeight=FontWeight.Bold); Text(q.symbol + "  •  " + q.unit + "  •  " + q.source,color=muted,fontSize=11.sp); Text("آخرین به‌روزرسانی به وقت گوشی: " + formatLocalTimestamp(q.timestamp),color=muted,fontSize=10.sp)
 } }
}

private fun formatLocalTimestamp(raw:String):String {
 if(raw.isBlank() || raw=="—") return "نامشخص"
 return try {
   val formatter=DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm:ss")
     .withZone(ZoneId.systemDefault())
   formatter.format(Instant.parse(raw))
 } catch (_:Exception) { raw }
}


private fun fetchBacktestComparison():List<CompareRow>{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/backtest/ema-crossover/compare?symbol=xau").openConnection() as HttpURLConnection
 connection.requestMethod="GET";connection.connectTimeout=15000;connection.readTimeout=30000
 try {
   if(connection.responseCode !in 200..299) throw IllegalStateException("Comparison HTTP "+connection.responseCode)
   val root=JSONObject(connection.inputStream.bufferedReader().use{it.readText()})
   val intervals=root.optJSONArray("intervals")?:JSONArray()
   val rows=mutableListOf<CompareRow>()
   for(i in 0 until intervals.length()){
     val interval=intervals.getJSONObject(i)
     val results=interval.optJSONArray("results")?:JSONArray()
     for(j in 0 until results.length()){
       val item=results.getJSONObject(j)
       rows.add(CompareRow(interval.optString("interval"),item.optInt("fast_period"),item.optInt("slow_period"),
         item.optDouble("net_return_pct"),item.optDouble("max_drawdown_pct"),item.optInt("closed_trades"),
         item.optDouble("win_rate_pct"),item.optString("status","UNAVAILABLE")))
     }
   }
   return rows
 } finally {connection.disconnect()}
}

private fun fetchWalkForward():WalkForwardUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/backtest/walk-forward/live?symbol=xau&interval=60m").openConnection() as HttpURLConnection
 connection.requestMethod="GET";connection.connectTimeout=15000;connection.readTimeout=45000
 try {
   if(connection.responseCode !in 200..299) throw IllegalStateException("Walk-forward HTTP "+connection.responseCode)
   val root=JSONObject(connection.inputStream.bufferedReader().use{it.readText()})
   val array=root.optJSONArray("folds")?:JSONArray()
   val folds=(0 until array.length()).map { i ->
     val item=array.getJSONObject(i)
     WalkForwardFold(item.optInt("fold"),item.optString("selected_strategy"),
       item.optString("test_start"),item.optString("test_end"),
       item.optDouble("out_of_sample_return_pct"),item.optDouble("out_of_sample_drawdown_pct"),
       item.optInt("out_of_sample_trades"),item.optDouble("out_of_sample_win_rate_pct"))
   }
   return WalkForwardUi(root.optDouble("compounded_out_of_sample_return_pct"),
     root.optDouble("worst_fold_drawdown_pct"),root.optInt("total_out_of_sample_trades"),
     root.optDouble("aggregate_out_of_sample_win_rate_pct"),folds)
 } finally {connection.disconnect()}
}

private fun fetchSignalHistory():List<SignalHistoryRow>{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/signals/history?limit=50").openConnection() as HttpURLConnection
 connection.requestMethod="GET";connection.connectTimeout=10000;connection.readTimeout=15000
 try {
   if(connection.responseCode !in 200..299) throw IllegalStateException("History HTTP "+connection.responseCode)
   val root=JSONObject(connection.inputStream.bufferedReader().use{it.readText()})
   val rows=root.optJSONArray("records")?:JSONArray()
   return (0 until rows.length()).map { i ->
     val item=rows.getJSONObject(i)
     fun value(key:String):String=if(item.isNull(key)) "" else item.optString(key,"")
     SignalHistoryRow(value("signal"),value("trend"),item.optInt("confidence"),
       value("recorded_at"),value("last_candle_at"),
       value("entry"),value("stop_loss"),value("take_profit"))
   }
 } finally {connection.disconnect()}
}

private fun fetchSignalPerformance():SignalPerformanceUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/signals/performance").openConnection() as HttpURLConnection
 connection.requestMethod="GET";connection.connectTimeout=12000;connection.readTimeout=25000
 try {
   val stream=if(connection.responseCode in 200..299) connection.inputStream else connection.errorStream
   val root=JSONObject(stream.bufferedReader().use{it.readText()})
   if(connection.responseCode !in 200..299) throw IllegalStateException(root.optString("error","Performance unavailable"))
   val array=root.optJSONArray("horizons")?:JSONArray()
   val horizons=(0 until array.length()).map { i ->
     val h=array.getJSONObject(i)
     fun optional(key:String):Double?=if(h.isNull(key)) null else h.optDouble(key)
     SignalPerformanceHorizon(h.optInt("horizon_candles"),h.optInt("scored"),h.optInt("wins"),
       h.optInt("losses"),h.optInt("flats"),optional("win_rate_pct"),optional("average_return_pct"),
       optional("average_favorable_pct"),optional("average_adverse_pct"))
   }
   return SignalPerformanceUi(horizons,root.optInt("directional_signals"),root.optInt("pending_count"),
     root.optInt("unavailable_count"),root.optString("market_last_candle_at",""),
     root.optString("warning","ارزیابی توصیفی است و تضمین سود نیست."))
 } finally {connection.disconnect()}
}

private fun fetchLiveBacktest(interval:String,fastPeriod:Int,slowPeriod:Int):BacktestUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/paper-trading/backtest").openConnection() as HttpURLConnection
 connection.requestMethod="POST";connection.connectTimeout=12000;connection.readTimeout=30000
 connection.doOutput=true
 connection.setRequestProperty("Content-Type","application/json")
 try {
   val request=JSONObject().put("symbol","xau").put("interval",interval)
     .put("fast_period",fastPeriod).put("slow_period",slowPeriod)
     .put("starting_capital",10000).put("risk_fraction",0.01)
     .put("contract_value_per_price_unit",1).put("fee_bps",10).put("slippage_bps",5)
   connection.outputStream.use{it.write(request.toString().toByteArray(Charsets.UTF_8))}
   val stream=if(connection.responseCode in 200..299) connection.inputStream else connection.errorStream
   val root=JSONObject(stream.bufferedReader().use{it.readText()})
   if(connection.responseCode !in 200..299) throw IllegalStateException(root.optString("error","Backtest unavailable"))
   val warning=listOf(root.optString("warning"),root.optString("history_note"))
     .filter{it.isNotBlank()&&it!="null"}.joinToString(" ")
   return BacktestUi(root.optString("interval","60m"),root.optInt("candle_count",root.optJSONObject("data_quality")?.optInt("candle_count")?:0),
     root.optDouble("starting_capital"),root.optDouble("final_equity"),
     root.optDouble("net_return_pct"),root.optDouble("max_drawdown_pct"),
     root.optInt("closed_trades"),root.optDouble("win_rate_pct"),"در این نسخه محاسبه نشده",
     root.optString("last_candle_at",""),warning.ifBlank{"آزمون پژوهشی؛ نتیجه تضمین‌کننده عملکرد آینده نیست."})
 } finally { connection.disconnect() }
}

private fun fetchLatestSignal():SignalUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/signals/multi-timeframe?symbol=xau").openConnection() as HttpURLConnection
 connection.requestMethod="GET"; connection.connectTimeout=12000; connection.readTimeout=15000
 try {
   val stream=if(connection.responseCode in 200..299) connection.inputStream else connection.errorStream
   val root=JSONObject(stream.bufferedReader().use{it.readText()})
   val reasons=root.optJSONArray("reasons") ?: JSONArray()
   val reason=if(root.has("reason") && !root.isNull("reason")) root.optString("reason") else
     (0 until reasons.length()).joinToString(" • "){reasons.optString(it)}
   fun number(key:String):String = if(root.isNull(key) || !root.has(key)) "—" else String.format(Locale.US,"%.2f",root.optDouble(key))
   val timeframes=root.optJSONObject("timeframes") ?: JSONObject()
   val short=timeframes.optJSONObject("15m")?.optString("signal","—") ?: "—"
   val hourly=timeframes.optJSONObject("60m")?.optString("signal","—") ?: "—"
   val daily=timeframes.optJSONObject("1d")?.optString("trend","—") ?: "—"
   val quality=root.optJSONObject("signal_quality")
   val blocked=quality?.optJSONArray("blocked_reasons") ?: JSONArray()
   val blockedText=(0 until blocked.length()).joinToString(" • "){blocked.optString(it)}
   val progress=if(quality!=null) "${quality.optInt("passed_checks")}/${quality.optInt("required_checks")} کنترل کیفیت" else "کنترل کیفیت نامشخص"
   val timeframeDetails=listOf("15m" to short,"60m" to hourly,"1D" to daily).joinToString("  •  "){ "${it.first}: ${it.second}" }
   return SignalUi(root.optString("signal","NO_TRADE"),root.optInt("confidence",0),
     root.optString("trend","UNKNOWN"),number("entry"),number("stop_loss"),number("take_profit"),
     root.optString("last_candle_at",""),
     root.optString("market_data_status",root.optString("data_status","UNKNOWN")),
     reason.ifBlank{"شرایط ورود کامل نیست؛ فعلاً معامله نکن."},
     timeframeDetails,
     root.optJSONObject("market_regime")?.optString("status","UNKNOWN") ?: "UNKNOWN",
     root.optJSONObject("market_regime")?.optString("reason","رژیم بازار مشخص نیست؛ احتیاط کنید.") ?: "رژیم بازار مشخص نیست؛ احتیاط کنید.",
     quality?.optString("status","UNKNOWN") ?: "UNKNOWN",
     blockedText,progress)
 } finally { connection.disconnect() }
}


@Composable private fun MarketDataHealthCard(result:Result<MarketDataHealthUi>?){
 Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){
  Column(Modifier.fillMaxWidth().padding(14.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
   Text("سلامت داده‌های تحلیلی اونس",color=gold,fontWeight=FontWeight.Bold)
   when {
    result==null -> Text("در حال بررسی تازگی و کیفیت کندل‌ها…",color=muted,fontSize=12.sp)
    result.isFailure -> {
     Text("داده OHLC معتبر در دسترس نیست؛ تحلیل قابل اتکا نیست.",color=Color(0xFFFFB86B),fontWeight=FontWeight.SemiBold,fontSize=12.sp)
     Text(result.exceptionOrNull()?.message ?: "خطای دریافت اطلاعات",color=muted,fontSize=10.sp)
    }
    else -> {
     val h=result.getOrThrow()
     val clean=h.status=="LIVE" && h.quality=="CLEAN"
     Text(if(clean) "داده تازه و بدون شکاف شناسایی‌شده" else if(h.quality=="GAPS_DETECTED") "هشدار: در توالی کندل‌ها شکاف وجود دارد" else "وضعیت داده نیازمند بررسی",color=if(clean) Color(0xFF8FD6A8) else Color(0xFFFFB86B),fontWeight=FontWeight.SemiBold,fontSize=12.sp)
     Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("منبع / بازه",color=muted,fontSize=11.sp);Text(h.provider+" • "+h.interval,color=Color.White,fontSize=11.sp)}
     Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("تعداد کندل معتبر",color=muted,fontSize=11.sp);Text(h.candleCount.toString(),color=Color.White,fontSize=11.sp)}
     Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("سن آخرین کندل",color=muted,fontSize=11.sp);Text(if(h.ageSeconds<60) h.ageSeconds.toString()+" ثانیه" else (h.ageSeconds/60).toString()+" دقیقه",color=Color.White,fontSize=11.sp)}
     Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("شکاف / بازه ازدست‌رفته",color=muted,fontSize=11.sp);Text(h.gapCount.toString()+" / "+h.missingIntervals.toString(),color=if(h.gapCount==0) Color.White else Color(0xFFFFB86B),fontSize=11.sp)}
     if(h.largestGap>0) Text("بزرگ‌ترین شکاف: "+h.largestGap+" بازه",color=Color(0xFFFFB86B),fontSize=10.sp)
     Text("آخرین کندل بسته‌شده: "+formatLocalTimestamp(h.lastCandle),color=muted,fontSize=10.sp)
     Text(h.note,color=muted,fontSize=10.sp)
    }
   }
  }
 }
}

private fun fetchMarketDataHealth():MarketDataHealthUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/market/candles?symbol=xau&interval=60m").openConnection() as HttpURLConnection
 connection.requestMethod="GET";connection.connectTimeout=10000;connection.readTimeout=15000
 try {
  val code=connection.responseCode
  val stream=if(code in 200..299) connection.inputStream else connection.errorStream
  val root=JSONObject(stream.bufferedReader().use{it.readText()})
  if(code !in 200..299) throw IllegalStateException(root.optString("error","OHLC unavailable"))
  val quality=root.optJSONObject("data_quality")?:JSONObject()
  return MarketDataHealthUi(root.optString("status","UNKNOWN"),quality.optString("status","UNKNOWN"),
   root.optString("provider","—"),root.optString("interval","60m"),
   quality.optInt("candle_count",root.optJSONArray("candles")?.length()?:0),
   root.optLong("age_seconds",-1L),quality.optInt("gap_count",0),quality.optInt("missing_intervals",0),
   quality.optInt("largest_gap_intervals",0),root.optString("last_candle_at",""),
   quality.optString("note",root.optString("note","گزارش کیفیت از سرویس داده دریافت شد.")))
 } finally {connection.disconnect()}
}

private fun fetchPaperMonitorStatus():PaperMonitorStatusUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/paper/monitor/status").openConnection() as HttpURLConnection
 connection.requestMethod="GET";connection.connectTimeout=7000;connection.readTimeout=7000
 try{
  if(connection.responseCode !in 200..299) throw IllegalStateException("Monitor status HTTP "+connection.responseCode)
  val root=JSONObject(connection.inputStream.bufferedReader().use{it.readText()})
  val monitor=root.optJSONObject("monitor")?:JSONObject()
  return PaperMonitorStatusUi(root.optString("status","NOT_RUN"),
   monitor.optString("provider",""),monitor.optString("interval",root.optString("monitor_interval","")),
   monitor.optInt("accounts_checked"),monitor.optInt("trades_processed"),monitor.optInt("closed_trades"),
   monitor.optString("candle_at",""),monitor.optString("completed_at",""),
   monitor.optString("error",""),monitor.optString("mode",root.optString("mode","PAPER_ONLY")))
 }finally{connection.disconnect()}
}

@Composable private fun PaperMonitorHealthCard(state:Result<PaperMonitorStatusUi>?){
 Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){
  Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(7.dp)){
   Text("سلامت پایش خودکار معاملات",color=gold,fontWeight=FontWeight.Bold,fontSize=16.sp)
   when{
    state==null -> Text("در حال دریافت وضعیت موتور پایش…",color=muted,fontSize=12.sp)
    state.isFailure -> Text("وضعیت موتور دریافت نشد؛ اتصال سرور را بررسی کن.",color=Color(0xFFFFB86B),fontSize=12.sp)
    else -> {
     val s=state.getOrThrow()
     val healthy=s.status=="OK"||s.status=="IDLE"
     Text(when(s.status){"OK"->"آخرین اجرا موفق بود";"IDLE"->"موتور فعال است؛ هنوز حسابی برای پایش ثبت نشده";"ERROR"->"آخرین اجرای پایش با خطا مواجه شد";else->"هنوز اجرای موفقی ثبت نشده است"},
      color=if(healthy) Color(0xFF8FD6A8) else Color(0xFFFFB86B),fontWeight=FontWeight.SemiBold,fontSize=13.sp)
     Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
      Text("حساب‌های بررسی‌شده: ${s.accountsChecked}",color=muted,fontSize=11.sp)
      Text("معاملات بررسی‌شده: ${s.tradesProcessed}",color=muted,fontSize=11.sp)
     }
     Text("معاملات بسته‌شده در آخرین اجرا: ${s.closedTrades}",color=Color.White,fontSize=12.sp)
     if(s.completedAt.isNotBlank()) Text("آخرین بررسی: ${formatLocalTimestamp(s.completedAt)}",color=muted,fontSize=10.sp)
     if(s.candleAt.isNotBlank()) Text("آخرین کندل بازار: ${formatLocalTimestamp(s.candleAt)}",color=muted,fontSize=10.sp)
     if(s.error.isNotBlank()) Text(s.error,color=Color(0xFFFFB86B),fontSize=10.sp)
     Text("زمان‌بندی هر ۵ دقیقه • تحلیل بر اساس کندل کامل ۱۵ دقیقه‌ای • فقط معاملات آزمایشی",
      color=muted,fontSize=10.sp)
    }
   }
  }
 }
}

private fun fetchQuotes():List<QuoteUi>{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/market/quotes").openConnection() as HttpURLConnection
 connection.requestMethod="GET"; connection.connectTimeout=7000; connection.readTimeout=7000
 try { if(connection.responseCode !in 200..299) throw IllegalStateException("HTTP " + connection.responseCode)
   val body=connection.inputStream.bufferedReader().use{it.readText()}; val root=JSONObject(body); val arr=root.getJSONArray("quotes"); val result=mutableListOf<QuoteUi>()
   for(i in 0 until arr.length()){ val o=arr.getJSONObject(i); val p=if(o.isNull("price")) "—" else String.format(Locale.US,"%,.2f",o.getDouble("price")); result.add(QuoteUi(o.optString("symbol"),o.optString("name"),p,o.optString("unit"),o.optString("source"),o.optString("status"),o.optString("timestamp","—"))) }
   return result
 } finally { connection.disconnect() }
}

private fun fetchHistory(symbol:String):HistoryUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/market/history?symbol="+symbol).openConnection() as HttpURLConnection
 connection.requestMethod="GET"; connection.connectTimeout=10000; connection.readTimeout=15000
 try {
   if(connection.responseCode !in 200..299) throw IllegalStateException("History HTTP "+connection.responseCode)
   val root=JSONObject(connection.inputStream.bufferedReader().use{it.readText()})
   val series=root.optJSONObject("series") ?: JSONObject()
   val points=mutableListOf<HistoryPoint>()
   collectHistory(series,points)
   val unique=points.filter{it.value>0 && it.value.isFinite()}.distinctBy{it.date}.sortedBy{it.date}
   return HistoryUi(symbol,unique,root.optString("note","میانگین روزانه بازار؛ نه کندل OHLC. منبع: NerkhAra"))
 } finally { connection.disconnect() }
}

private fun collectHistory(value:Any?,out:MutableList<HistoryPoint>){
 when(value){
   is JSONObject -> {
     val dateKeys=listOf("date","day","day_utc","as_of")
     val valueKeys=listOf("price","mean","value","average","daily_mean","close")
     var date:String?=null; var price:Double?=null
     for(k in dateKeys){val v=value.opt(k);if(v is String){date=v;break}}
     for(k in valueKeys){val v=value.opt(k);if(v is Number){price=v.toDouble();break}}
     if(date!=null && price!=null) out.add(HistoryPoint(date!!,price!!))
     val keys=value.keys()
     while(keys.hasNext()){val k=keys.next();val child=value.opt(k)
       if(child is JSONArray || child is JSONObject) collectHistory(child,out)
       else if(date==null && k.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) && child is Number) out.add(HistoryPoint(k,child.toDouble()))
     }
   }
   is JSONArray -> for(i in 0 until value.length()) collectHistory(value.opt(i),out)
 }
}


@Composable private fun IndicatorRow(label:String,value:Double,decimals:Int=2){
 Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
   Text(label,color=muted,fontSize=12.sp)
   Text(String.format(Locale.US,"%."+decimals+"f",value),color=Color.White,fontSize=12.sp,fontWeight=FontWeight.SemiBold)
 }
}

private fun emaValues(values:List<Double>,period:Int):List<Double>{
 if(period<=0 || values.size<period) return emptyList()
 val alpha=2.0/(period+1.0)
 val out=mutableListOf(values.take(period).average())
 for(v in values.drop(period)) out.add(alpha*v+(1-alpha)*out.last())
 return out
}

private fun calculateIndicators(values:List<Double>):IndicatorUi?{
 if(values.size<50 || values.any{!it.isFinite() || it<=0.0}) return null
 val e20=emaValues(values,20).lastOrNull()?:return null
 val e50=emaValues(values,50).lastOrNull()?:return null
 val period=14
 val changes=values.zipWithNext{a,b->b-a}
 var gain=changes.take(period).sumOf{maxOf(it,0.0)}/period
 var loss=changes.take(period).sumOf{maxOf(-it,0.0)}/period
 for(change in changes.drop(period)){
   gain=(gain*(period-1)+maxOf(change,0.0))/period
   loss=(loss*(period-1)+maxOf(-change,0.0))/period
 }
 val rsi=when { loss==0.0 && gain>0.0 -> 100.0; loss==0.0 -> 50.0; else -> 100.0-100.0/(1.0+gain/loss) }
 val fast=emaValues(values,12); val slow=emaValues(values,26)
 if(fast.size<slow.size) return null
 val macdLine=fast.drop(fast.size-slow.size).zip(slow){a,b->a-b}
 val signalLine=emaValues(macdLine,9)
 if(signalLine.isEmpty()) return null
 val macd=macdLine.last(); val signal=signalLine.last()
 return IndicatorUi(e20,e50,rsi,macd,signal,macd-signal)
}


private fun securePaperPrefs(context:Context)=run {
 val master=MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
 EncryptedSharedPreferences.create(context,"ayyar_paper_account_secure",master,
  EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
  EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
}

private fun paperApi(method:String,path:String,token:String?=null,body:JSONObject?=null):JSONObject {
 val connection=URL(BuildConfig.API_BASE_URL+path).openConnection() as HttpURLConnection
 connection.requestMethod=method;connection.connectTimeout=10000;connection.readTimeout=15000
 connection.setRequestProperty("Accept","application/json")
 if(body!=null){connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json");connection.outputStream.use{it.write(body.toString().toByteArray(Charsets.UTF_8))}}
 if(!token.isNullOrBlank()) connection.setRequestProperty("Authorization","Bearer "+token)
 try{
  val code=connection.responseCode
  val stream=if(code in 200..299) connection.inputStream else connection.errorStream
  val result=JSONObject(stream.bufferedReader().use{it.readText()})
  if(code !in 200..299) throw IllegalStateException(result.optString("error","HTTP $code"))
  return result
 }finally{connection.disconnect()}
}

@Composable private fun PaperAccountCard(){
 val context=LocalContext.current
 val prefs=remember{runCatching{securePaperPrefs(context)}.getOrNull()}
 var accountId by remember{mutableStateOf(prefs?.getString("account_id","")?:"")}
 var token by remember{mutableStateOf(prefs?.getString("access_token","")?:"")}
 var capital by remember{mutableStateOf("10000")}
 var currency by remember{mutableStateOf("USD")}
 var symbol by remember{mutableStateOf("XAUUSD")}
 var side by remember{mutableStateOf("BUY")}
 var quantity by remember{mutableStateOf("0.01")}
 var entry by remember{mutableStateOf("")}
 var stop by remember{mutableStateOf("")}
 var target by remember{mutableStateOf("")}
 var strategyId by remember{mutableStateOf("MANUAL")}
 var signalId by remember{mutableStateOf("")}
 var exitPrice by remember{mutableStateOf("")}
 var summary by remember{mutableStateOf<JSONObject?>(null)}
 var trades by remember{mutableStateOf<JSONArray?>(null)}
 var status by remember{mutableStateOf(if(prefs==null) "ذخیره‌سازی رمزگذاری‌شده دستگاه در دسترس نیست." else "حساب آزمایشی ایجاد نشده است.")}
 var busy by remember{mutableStateOf(false)}
 val scope= rememberCoroutineScope()

 fun reload(){
  if(accountId.isBlank()||token.isBlank()) return
  scope.launch{
   busy=true
   try{
    val result=withContext(Dispatchers.IO){
     val s=paperApi("GET","/v1/paper/accounts/$accountId",token)
     val t=paperApi("GET","/v1/paper/accounts/$accountId/trades",token)
     Pair(s,t.optJSONArray("trades")?:JSONArray())
    }
    summary=result.first;trades=result.second;status="حساب آزمایشی همگام شد."
   }catch(e:Exception){status=e.message?:"خطا در دریافت حساب آزمایشی."}
   finally{busy=false}
  }
 }

 LaunchedEffect(accountId,token){
  if(accountId.isNotBlank()&&token.isNotBlank()){
   try{
    val result=withContext(Dispatchers.IO){
     val s=paperApi("GET","/v1/paper/accounts/$accountId",token)
     val t=paperApi("GET","/v1/paper/accounts/$accountId/trades",token)
     Pair(s,t.optJSONArray("trades")?:JSONArray())
    }
    summary=result.first;trades=result.second;status="حساب آزمایشی بازیابی شد."
   }catch(e:Exception){status=e.message?:"بازیابی حساب ناموفق بود."}
  }
 }

 Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){
  Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(9.dp)){
   Text("حساب آزمایشی پایدار",color=gold,fontSize=18.sp,fontWeight=FontWeight.Bold)
   Text("ذخیره روی Cloudflare SQLite • بدون اتصال به بروکر • بدون سفارش واقعی",color=muted,fontSize=11.sp)
   if(accountId.isBlank()){
    OutlinedTextField(value=capital,onValueChange={capital=it},label={Text("سرمایه اولیه مجازی")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
     FilterChip(selected=currency=="USD",onClick={currency="USD"},label={Text("USD")})
     FilterChip(selected=currency=="IRT",onClick={currency="IRT"},label={Text("تومان")})
    }
    Button(enabled=!busy&&prefs!=null&&capital.toDoubleOrNull()?.let{it>0.0}==true,onClick={
     scope.launch{
      busy=true
      try{
       val created=withContext(Dispatchers.IO){paperApi("POST","/v1/paper/accounts",body=JSONObject().put("starting_capital",capital.toDouble()).put("currency",currency))}
       val id=created.getString("account_id");val access=created.getString("access_token")
       withContext(Dispatchers.IO){prefs?.edit()?.putString("account_id",id)?.putString("access_token",access)?.apply()}
       accountId=id;token=access;status="حساب ساخته شد؛ توکن در حافظه رمزگذاری‌شده دستگاه ذخیره شد."
      }catch(e:Exception){status=e.message?:"ساخت حساب ناموفق بود."}
      finally{busy=false}
     }
    },modifier=Modifier.fillMaxWidth(),colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text(if(busy)"در حال ایجاد…" else "ایجاد حساب آزمایشی")}
   }else{
    Text("شناسه حساب: "+accountId,color=muted,fontSize=10.sp)
    summary?.let{s->
     Text("موجودی: "+String.format(Locale.US,"%,.2f",s.optDouble("balance"))+" "+s.optString("currency"),color=Color.White,fontSize=22.sp,fontWeight=FontWeight.Bold)
     Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
      Text("سود/زیان تحقق‌یافته",color=muted,fontSize=11.sp)
      Text(String.format(Locale.US,"%,.2f",s.optDouble("realized_pnl")),color=if(s.optDouble("realized_pnl")>=0) Color(0xFF8FD6A8) else Color(0xFFFF8D8D),fontSize=12.sp)
     }
     Text("معاملات باز: ${s.optInt("open_trades")} • بسته: ${s.optInt("closed_trades")}",color=muted,fontSize=11.sp)
    }
    OutlinedButton(onClick={reload()},enabled=!busy,modifier=Modifier.fillMaxWidth()){Text("به‌روزرسانی حساب و دفتر معاملات")}
    OutlinedButton(enabled=!busy,onClick={
     scope.launch{
      busy=true
      try{
       val result=withContext(Dispatchers.IO){
        paperApi("POST","/v1/paper/accounts/$accountId/monitor",token,JSONObject())
       }
       val closed=result.optInt("closed")
       status="پایش کندل ۱۵ دقیقه‌ای XAUS انجام شد؛ $closed معامله با حد ضرر/سود بسته شد."
       val refreshed=withContext(Dispatchers.IO){
        val s=paperApi("GET","/v1/paper/accounts/$accountId",token)
        val t=paperApi("GET","/v1/paper/accounts/$accountId/trades",token)
        Pair(s,t.optJSONArray("trades")?:JSONArray())
       }
       summary=refreshed.first;trades=refreshed.second
      }catch(e:Exception){status=e.message?:"داده بازار در دسترس نیست؛ هیچ معامله‌ای بسته نشد."}
      finally{busy=false}
     }
    },modifier=Modifier.fillMaxWidth()){Text("پایش حد ضرر و حد سود با کندل زنده")}
    Text("این دکمه آخرین کندل کامل ۱۵ دقیقه‌ای XAU/USD را بررسی می‌کند؛ پایش خودکار سرور هر ۵ دقیقه فعال است؛ بستن معامله بر اساس کندل کامل ۱۵ دقیقه‌ای ممکن است تا بسته‌شدن کندل تأخیر داشته باشد.",color=muted,fontSize=10.sp)
    Divider(color=Color(0xFF303746))
    Text("ثبت موقعیت فرضی",color=gold,fontWeight=FontWeight.SemiBold)
    OutlinedTextField(value=symbol,onValueChange={symbol=it.uppercase(Locale.US)},label={Text("نماد (مثلاً XAUUSD)")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
     FilterChip(selected=side=="BUY",onClick={side="BUY"},label={Text("خرید")})
     FilterChip(selected=side=="SELL",onClick={side="SELL"},label={Text("فروش")})
    }
    OutlinedTextField(value=quantity,onValueChange={quantity=it},label={Text("حجم")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    OutlinedTextField(value=entry,onValueChange={entry=it},label={Text("قیمت ورود")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    OutlinedTextField(value=stop,onValueChange={stop=it},label={Text("حد ضرر")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    OutlinedTextField(value=target,onValueChange={target=it},label={Text("حد سود")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    OutlinedTextField(value=strategyId,onValueChange={strategyId=it},label={Text("شناسه استراتژی (مثلاً EMA20_50)")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    OutlinedTextField(value=signalId,onValueChange={signalId=it},label={Text("شناسه سیگنال (اختیاری)")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    val valid=quantity.toDoubleOrNull()?.let{it>0}==true&&entry.toDoubleOrNull()?.let{it>0}==true&&stop.toDoubleOrNull()?.let{it>0}==true&&target.toDoubleOrNull()?.let{it>0}==true
    Button(enabled=!busy&&valid,onClick={
     scope.launch{
      busy=true
      try{
       withContext(Dispatchers.IO){paperApi("POST","/v1/paper/accounts/$accountId/trades",token,
        JSONObject().put("symbol",symbol.trim()).put("side",side).put("quantity",quantity.toDouble())
         .put("entry_price",entry.toDouble()).put("stop_loss",stop.toDouble()).put("take_profit",target.toDouble())
         .put("idempotency_key",java.util.UUID.randomUUID().toString())
         .put("strategy_id",strategyId.trim().ifBlank{"MANUAL"})
         .put("signal_type",side).apply{if(signalId.isNotBlank())put("signal_id",signalId.trim())})}
       status="موقعیت آزمایشی ثبت شد و به استراتژی ${strategyId.trim().ifBlank{"MANUAL"}} منتسب شد."
       val result=withContext(Dispatchers.IO){
        val s=paperApi("GET","/v1/paper/accounts/$accountId",token)
        val t=paperApi("GET","/v1/paper/accounts/$accountId/trades",token)
        Pair(s,t.optJSONArray("trades")?:JSONArray())
       }
       summary=result.first;trades=result.second
      }catch(e:Exception){status=e.message?:"ثبت موقعیت ناموفق بود."}
      finally{busy=false}
     }
    },modifier=Modifier.fillMaxWidth(),colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text("ثبت معامله آزمایشی")}
    Text("ریسک هر موقعیت حداکثر ۱٪ موجودی است؛ قیمت‌ها را فقط از داده معتبر بازار وارد کن.",color=muted,fontSize=10.sp)
    OutlinedTextField(value=exitPrice,onValueChange={exitPrice=it},label={Text("قیمت خروج برای بستن موقعیت")},modifier=Modifier.fillMaxWidth(),singleLine=true)
    Text("دفتر معاملات",color=gold,fontWeight=FontWeight.SemiBold)
    val rows=trades
    if(rows==null||rows.length()==0) Text("هنوز معامله‌ای ثبت نشده است.",color=muted,fontSize=11.sp)
    else for(i in 0 until rows.length()){
     val trade=rows.optJSONObject(i)?:continue
     Column(Modifier.fillMaxWidth().padding(vertical=4.dp),verticalArrangement=Arrangement.spacedBy(3.dp)){
      Text("${trade.optString("symbol")} • ${if(trade.optString("side")=="BUY")"خرید" else "فروش"} • ${trade.optString("status")}",color=Color.White,fontWeight=FontWeight.SemiBold,fontSize=12.sp)
      Text("حجم ${trade.optDouble("quantity")} • ورود ${trade.optDouble("entry_price")} • حدضرر ${trade.optDouble("stop_loss")} • هدف ${trade.optDouble("take_profit")}",color=muted,fontSize=10.sp)
      if(trade.optString("status")=="OPEN"){
       OutlinedButton(enabled=!busy&&exitPrice.toDoubleOrNull()?.let{it>0}==true,onClick={
        scope.launch{
         busy=true
         try{
          withContext(Dispatchers.IO){paperApi("POST","/v1/paper/accounts/$accountId/trades/${trade.getString("trade_id")}/close",token,JSONObject().put("exit_price",exitPrice.toDouble()))}
          val result=withContext(Dispatchers.IO){
           val s=paperApi("GET","/v1/paper/accounts/$accountId",token)
           val t=paperApi("GET","/v1/paper/accounts/$accountId/trades",token)
           Pair(s,t.optJSONArray("trades")?:JSONArray())
          }
          summary=result.first;trades=result.second;status="معامله آزمایشی بسته شد."
         }catch(e:Exception){status=e.message?:"بستن معامله ناموفق بود."}
         finally{busy=false}
        }
       },modifier=Modifier.fillMaxWidth()){Text("بستن با قیمت واردشده")}
      }else{
       Text("سود/زیان تحقق‌یافته: "+String.format(Locale.US,"%.2f",trade.optDouble("realized_pnl")),color=muted,fontSize=10.sp)
      }
     }
     Divider(color=Color(0xFF303746))
    }
   }
   if(accountId.isNotBlank()) PaperActivityCard(accountId,token)
   Text(status,color=if(status.contains("ناموفق")||status.contains("خطا")||status.contains("حد")||status.contains("موجودی")) Color(0xFFFFB86B) else muted,fontSize=11.sp)
  }
 }
}

@Composable private fun PaperActivityCard(accountId:String,token:String){
 var refresh by remember{mutableIntStateOf(0)}
 var report by remember{mutableStateOf<JSONObject?>(null)}
 var performance by remember{mutableStateOf<JSONObject?>(null)}
 var period by remember{mutableStateOf("week")}
 var notifications by remember{mutableStateOf<JSONArray?>(null)}
 var strategyAnalytics by remember{mutableStateOf<JSONObject?>(null)}
 var loading by remember{mutableStateOf(false)}
 var error by remember{mutableStateOf("")}
 val scope=rememberCoroutineScope()
 fun load(){
  scope.launch{
   loading=true;error=""
   try{
    val result=withContext(Dispatchers.IO){
     val day=paperApi("GET","/v1/paper/accounts/$accountId/report/daily",token)
     val stats=paperApi("GET","/v1/paper/accounts/$accountId/report/performance?period=$period",token)
     val events=paperApi("GET","/v1/paper/accounts/$accountId/notifications",token)
     val attribution=paperApi("GET","/v1/paper/accounts/$accountId/analytics/strategy",token)
     arrayOf(day,stats,JSONObject().put("notifications",events.optJSONArray("notifications")?:JSONArray()),attribution)
    }
    report=result[0];performance=result[1];notifications=result[2].optJSONArray("notifications");strategyAnalytics=result[3]
   }catch(e:Exception){error=e.message?:"دریافت گزارش و اعلان‌ها ناموفق بود."}
   finally{loading=false}
  }
 }
 LaunchedEffect(accountId,token,refresh,period){if(accountId.isNotBlank()&&token.isNotBlank()) load()}
 Card(colors=CardDefaults.cardColors(containerColor=Color(0xFF151C28)),shape=RoundedCornerShape(14.dp)){
  Column(Modifier.fillMaxWidth().padding(12.dp),verticalArrangement=Arrangement.spacedBy(7.dp)){
   Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically){
    Text("گزارش روزانه و اعلان‌ها",color=gold,fontWeight=FontWeight.SemiBold,fontSize=14.sp)
    TextButton(onClick={refresh++},enabled=!loading){Text(if(loading)"در حال دریافت…" else "بروزرسانی")}
   }
   report?.let{r->
    Text("امروز (UTC) • معاملات بسته‌شده: ${r.optInt("closed_trades")}",color=Color.White,fontSize=12.sp)
    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
     Text("برد: ${r.optInt("wins")} • باخت: ${r.optInt("losses")}",color=muted,fontSize=11.sp)
     val pnl=r.optDouble("realized_pnl")
     Text("سود/زیان: ${String.format(Locale.US,"%.2f",pnl)}",color=if(pnl>=0) Color(0xFF8FD6A8) else Color(0xFFFF8D8D),fontSize=12.sp,fontWeight=FontWeight.SemiBold)
    }
    Text("کارمزد ثبت‌شده: ${String.format(Locale.US,"%.2f",r.optDouble("fees"))} • منطقه زمانی UTC",color=muted,fontSize=10.sp)
   }
   Divider(color=Color(0xFF303746))
   Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically){
    Text("عملکرد معاملات",color=Color.White,fontSize=12.sp,fontWeight=FontWeight.SemiBold)
    Row(horizontalArrangement=Arrangement.spacedBy(4.dp)){
     TextButton(onClick={period="week"},enabled=period!="week"){Text("۷ روز")}
     TextButton(onClick={period="month"},enabled=period!="month"){Text("۳۰ روز")}
    }
   }
   performance?.let{p->
    val pnl=p.optDouble("net_pnl")
    val pnlColor=if(pnl>=0) Color(0xFF8FD6A8) else Color(0xFFFF8D8D)
    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
     Column { Text("بازده خالص",color=muted,fontSize=10.sp);Text(String.format(Locale.US,"%.2f",pnl),color=pnlColor,fontSize=15.sp,fontWeight=FontWeight.Bold) }
     Column { Text("درصد برد",color=muted,fontSize=10.sp);Text(String.format(Locale.US,"%.1f%%",p.optDouble("win_rate_pct")),color=Color.White,fontSize=14.sp,fontWeight=FontWeight.SemiBold) }
     Column { Text("افت سرمایه",color=muted,fontSize=10.sp);Text(String.format(Locale.US,"%.2f%%",p.optDouble("max_drawdown_pct")),color=Color(0xFFFFB86B),fontSize=14.sp,fontWeight=FontWeight.SemiBold) }
    }
    val pf=if(p.isNull("profit_factor"))"—" else String.format(Locale.US,"%.2f",p.optDouble("profit_factor"))
    Text("معاملات: ${p.optInt("closed_trades")} • ضریب سود: $pf • امید ریاضی: ${String.format(Locale.US,"%.2f",p.optDouble("expectancy"))}",color=muted,fontSize=10.sp)
    Text("بیشترین افت: ${String.format(Locale.US,"%.2f",p.optDouble("max_drawdown"))} • کارمزد: ${String.format(Locale.US,"%.2f",p.optDouble("fees"))}",color=muted,fontSize=10.sp)
    val curve=p.optJSONArray("equity_curve")?:JSONArray()
    if(curve.length()>0){
     val maxAbs=(0 until curve.length()).maxOfOrNull{curve.optJSONObject(it)?.optDouble("daily_pnl")?.let{kotlin.math.abs(it)}?:0.0}?:0.0
     Row(Modifier.fillMaxWidth().height(48.dp),horizontalArrangement=Arrangement.spacedBy(3.dp),verticalAlignment=Alignment.Bottom){
      for(i in 0 until curve.length()){
       val point=curve.optJSONObject(i)?:continue
       val daily=point.optDouble("daily_pnl")
       val barHeight=if(maxAbs>0)(4.0+34.0*kotlin.math.abs(daily)/maxAbs).dp else 4.dp
       Box(Modifier.weight(1f).height(barHeight).background(if(daily>=0)Color(0xFF4D9B72) else Color(0xFFB75E5E),RoundedCornerShape(topStart=3.dp,topEnd=3.dp)))
      }
     }
     Text("نمودار تغییرات روزانه سود/زیان • ${p.optString("start_date")} تا ${p.optString("end_date")} (UTC)",color=muted,fontSize=9.sp)
    }
    Text("افت سرمایه بر اساس موجودی تحقق‌یافته روزانه محاسبه شده؛ سود/زیان باز و نوسان درون‌روزی در آن لحاظ نشده است.",color=muted,fontSize=9.sp)
   }
   Divider(color=Color(0xFF303746))
   Text("تحلیل عملکرد استراتژی‌ها",color=Color.White,fontSize=12.sp,fontWeight=FontWeight.SemiBold)
   strategyAnalytics?.let{analytics->
    Text("معاملات بسته‌شده: ${analytics.optInt("total_closed_trades")} • دارای شناسه استراتژی: ${analytics.optInt("attributed_closed_trades")} • بدون انتساب: ${analytics.optInt("unattributed_closed_trades")}",color=muted,fontSize=10.sp)
    val groups=analytics.optJSONArray("groups")?:JSONArray()
    if(groups.length()==0) Text("برای تحلیل، معاملات آزمایشی را با شناسه استراتژی و سیگنال ثبت کن.",color=muted,fontSize=10.sp)
    else for(i in 0 until minOf(groups.length(),8)){
     val group=groups.optJSONObject(i)?:continue
     val label=group.optString("strategy_id","UNATTRIBUTED")
     val signal=group.optString("signal_type","UNATTRIBUTED")
     val guidance=group.optString("risk_guidance","NO_AUTOMATIC_CHANGE")
     Column(verticalArrangement=Arrangement.spacedBy(2.dp)){
      Text("$label • $signal",color=gold,fontSize=11.sp,fontWeight=FontWeight.SemiBold)
      Text("تعداد: ${group.optInt("closed_trades")} • برد: ${String.format(Locale.US,"%.1f%%",group.optDouble("win_rate_pct"))} • خالص: ${String.format(Locale.US,"%.2f",group.optDouble("net_pnl"))}",color=muted,fontSize=10.sp)
      Text("امید ریاضی: ${String.format(Locale.US,"%.2f",group.optDouble("expectancy"))} • وضعیت نمونه: ${if(group.optString("sample_quality")=="MINIMUM_SAMPLE_MET")"حداقل نمونه تأمین شده" else "نمونه ناکافی"}",color=muted,fontSize=9.sp)
      if(guidance=="CONSIDER_HALF_RISK") Text("پیشنهاد احتیاطی: بررسی کاهش ریسک به نصف",color=Color(0xFFFFB86B),fontSize=10.sp)
     }
     if(i<minOf(groups.length(),8)-1) Divider(color=Color(0xFF303746))
    }
    Text("این تحلیل فقط معاملات دارای داده واقعی را گروه‌بندی می‌کند. پیشنهاد ریسک صرفاً راهنماست؛ ریسک خودکار تغییر نمی‌کند و هرگز افزایش نمی‌یابد.",color=muted,fontSize=9.sp)
   }
   Divider(color=Color(0xFF303746))
   Text("آخرین اعلان‌های بسته‌شدن",color=Color.White,fontSize=12.sp,fontWeight=FontWeight.SemiBold)
   val items=notifications
   if(items==null||items.length()==0) Text("هنوز اعلانی ثبت نشده است.",color=muted,fontSize=11.sp)
   else for(i in 0 until minOf(items.length(),8)){
    val event=items.optJSONObject(i)?:continue
    val pnl=event.optDouble("realized_pnl")
    Column(verticalArrangement=Arrangement.spacedBy(2.dp)){
     Text(event.optString("title","معامله بسته شد"),color=Color.White,fontSize=11.sp,fontWeight=FontWeight.SemiBold)
     Text(event.optString("message"),color=muted,fontSize=10.sp)
     Text(formatLocalTimestamp(event.optString("created_at")),color=muted,fontSize=9.sp)
    }
    if(i<minOf(items.length(),8)-1) Divider(color=Color(0xFF303746))
   }
   if(error.isNotBlank()) Text(error,color=Color(0xFFFFB86B),fontSize=10.sp)
   Text("اعلان‌ها داخل برنامه ذخیره می‌شوند؛ اعلان پوش‌نوتیفیکیشن سیستم‌عامل هنوز فعال نیست.",color=muted,fontSize=9.sp)
  }
 }
}
