package com.ayyar.smarttrader

import android.os.Bundle
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
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
data class IndicatorUi(val ema20:Double,val ema50:Double,val rsi14:Double,val macd:Double,val signal:Double,val histogram:Double)\ndata class SignalUi(val signal:String,val confidence:Int,val trend:String,val entry:String,val stop:String,val target:String,val lastCandle:String,val status:String,val reason:String)
private val bg=Color(0xFF090B10); private val panel=Color(0xFF171B24); private val gold=Color(0xFFD6AD55); private val muted=Color(0xFF9AA3B2)
private val historySymbols=listOf("gold-18k" to "طلای ۱۸ عیار","gold-24k" to "طلای ۲۴ عیار","gold-mesghal" to "مثقال طلا","coin-emami" to "سکه امامی","coin-half" to "نیم سکه","coin-quarter" to "ربع سکه","usd" to "دلار آزاد","xau" to "اونس جهانی")

class MainActivity:ComponentActivity(){ override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);setContent { AyyarApp() }} }

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun AyyarApp(){
 var refresh by remember { mutableIntStateOf(0) }
 var historyRefresh by remember { mutableIntStateOf(0) }
 var selectedSymbol by remember { mutableStateOf("gold-18k") }
 LaunchedEffect(Unit) { while (true) { delay(60000); refresh++ } }
 val snapshot by produceState<Result<List<QuoteUi>>?>(null, refresh) { value = runCatching { withContext(Dispatchers.IO) { fetchQuotes() } } }\n val signal by produceState<Result<SignalUi>?>(null, refresh) { value = runCatching { withContext(Dispatchers.IO) { fetchLatestSignal() } } }
 val history by produceState<Result<HistoryUi>?>(null, selectedSymbol, historyRefresh) { value=runCatching { withContext(Dispatchers.IO) { fetchHistory(selectedSymbol) } } }
 MaterialTheme { Surface(Modifier.fillMaxSize(),color=bg){ LazyColumn(Modifier.fillMaxSize().padding(18.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
   item { Text("عیار هوشمند",color=gold,fontSize=28.sp,fontWeight=FontWeight.Bold); Text("Ayyar Smart Trader  •  نسخه 0.9.0",color=muted,fontSize=12.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("وضعیت داده‌های بازار",color=muted); when { snapshot==null -> Text("در حال اتصال به سرور…",color=Color.White); snapshot!!.isFailure -> Text("سرور هنوز در دسترس نیست؛ قیمت ساختگی نمایش داده نمی‌شود.",color=Color(0xFFFFB86B)); else -> if (snapshot!!.getOrThrow().any { it.status=="LIVE" }) Text("قیمت‌های تازه دریافت شد",color=Color(0xFF8FD6A8)) else Text("اتصال برقرار است؛ فعلاً قیمت زنده معتبر در دسترس نیست.",color=Color(0xFFFFB86B)) }
      Button(onClick={refresh++},colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text("به‌روزرسانی قیمت‌ها")}
   } } }
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
   item { Text("مدیریت سرمایه و کنترل ریسک",color=gold,fontWeight=FontWeight.Bold,fontSize=18.sp) }
   item { RiskCalculator() }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("موتور تحلیل اونس جهانی طلا • تایم‌فریم یک‌ساعته",color=gold,fontWeight=FontWeight.Bold)
      when {
        signal==null -> Text("در حال دریافت کندل‌های واقعی و ارزیابی بازار…",color=muted)
        signal!!.isFailure -> Text("دریافت سیگنال ناموفق بود؛ تا دریافت داده معتبر معامله‌ای پیشنهاد نمی‌شود.",color=Color(0xFFFFB86B))
        else -> {
          val s=signal!!.getOrThrow()
          Text(when(s.signal){"BUY"->"سیگنال خرید";"SELL"->"سیگنال فروش";else->"بدون معامله"},color=when(s.signal){"BUY"->Color(0xFF8FD6A8);"SELL"->Color(0xFFFF8D8D);else->Color(0xFFFFB86B)},fontSize=22.sp,fontWeight=FontWeight.Bold)
          Text("وضعیت داده: ${s.status}  •  روند: ${s.trend}  •  امتیاز همگرایی: ${s.confidence}/100",color=muted,fontSize=11.sp)
          if(s.signal!="NO_TRADE"){
            IndicatorRow("نقطه ورود",s.entry.toDoubleOrNull()?:Double.NaN,2)
            IndicatorRow("حد ضرر",s.stop.toDoubleOrNull()?:Double.NaN,2)
            IndicatorRow("حد سود",s.target.toDoubleOrNull()?:Double.NaN,2)
          }
          Text(s.reason,color=muted,fontSize=11.sp)
          Text("آخرین کندل بسته‌شده: ${formatLocalTimestamp(s.lastCandle)}",color=muted,fontSize=10.sp)
        }
      }
      Text("منبع کندل: Yahoo Finance (XAUUSD=X). فقط اونس جهانی؛ برای طلای ۱۸ عیار و سکه ایران هنوز فید OHLC مستقل و معتبر متصل نشده است. امتیاز همگرایی احتمال موفقیت نیست. اجرای سفارش واقعی غیرفعال است.",color=muted,fontSize=11.sp)
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


private fun fetchLatestSignal():SignalUi{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/signals/latest?symbol=xau&interval=60m").openConnection() as HttpURLConnection
 connection.requestMethod="GET"; connection.connectTimeout=12000; connection.readTimeout=15000
 try {
   val stream=if(connection.responseCode in 200..299) connection.inputStream else connection.errorStream
   val root=JSONObject(stream.bufferedReader().use{it.readText()})
   val reasons=root.optJSONArray("reasons") ?: JSONArray()
   val reason=if(root.has("reason") && !root.isNull("reason")) root.optString("reason") else
     (0 until reasons.length()).joinToString(" • "){reasons.optString(it)}
   fun number(key:String):String = if(root.isNull(key) || !root.has(key)) "—" else String.format(Locale.US,"%.2f",root.optDouble(key))
   return SignalUi(root.optString("signal","NO_TRADE"),root.optInt("confidence",0),
     root.optString("trend","UNKNOWN"),number("entry"),number("stop_loss"),number("take_profit"),
     root.optString("market_last_candle_at",root.optString("last_candle_at","")),
     root.optString("market_data_status",root.optString("data_status","UNKNOWN")),reason.ifBlank{"شرایط ورود کامل نیست؛ فعلاً معامله نکن."})
 } finally { connection.disconnect() }
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
