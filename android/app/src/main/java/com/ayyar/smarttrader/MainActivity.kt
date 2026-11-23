package com.ayyar.smarttrader

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class QuoteUi(val symbol:String,val name:String,val price:String,val unit:String,val source:String,val status:String)
private val bg=Color(0xFF090B10); private val panel=Color(0xFF171B24); private val gold=Color(0xFFD6AD55); private val muted=Color(0xFF9AA3B2)
class MainActivity:ComponentActivity(){ override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);setContent { AyyarApp() }} }

@Composable fun AyyarApp(){
 var refresh by remember { mutableIntStateOf(0) }
 val snapshot by produceState<Result<List<QuoteUi>>?>(null, refresh) { value = runCatching { withContext(Dispatchers.IO) { fetchQuotes() } } }
 MaterialTheme { Surface(Modifier.fillMaxSize(),color=bg){ LazyColumn(Modifier.fillMaxSize().padding(18.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
   item { Text("عیار هوشمند",color=gold,fontSize=28.sp,fontWeight=FontWeight.Bold); Text("Ayyar Smart Trader  •  نسخه 0.3.0",color=muted,fontSize=12.sp) }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
      Text("وضعیت داده‌های بازار",color=muted); when { snapshot==null -> Text("در حال اتصال به سرور…",color=Color.White); snapshot!!.isFailure -> Text("سرور هنوز در دسترس نیست؛ قیمت ساختگی نمایش داده نمی‌شود.",color=Color(0xFFFFB86B)); else -> Text("دریافت اطلاعات انجام شد",color=Color(0xFF8FD6A8)) }
      Button(onClick={refresh++},colors=ButtonDefaults.buttonColors(containerColor=gold,contentColor=bg)){Text("به‌روزرسانی")}
   } } }
   if(snapshot?.isSuccess==true){ items(snapshot!!.getOrThrow()){ q -> QuoteCard(q) } }
   item { Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){ Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
      Text("موتور تحلیل",color=gold,fontWeight=FontWeight.Bold); Text("NO TRADE تا تأیید داده و شرایط معتبر",color=Color.White,fontSize=17.sp); Text("ریسک پیش‌فرض هر معامله حداکثر ۱٪ سرمایه است. اجرای سفارش واقعی غیرفعال است.",color=muted,fontSize=12.sp)
   } } }
   item { Text("منابع قیمت و زمان آخرین به‌روزرسانی کنار هر نرخ نمایش داده می‌شود. داده قدیمی برای تولید سیگنال مجاز نیست.",color=muted,fontSize=11.sp) }
 } } }
}

@Composable private fun QuoteCard(q:QuoteUi){
 Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(16.dp)){ Column(Modifier.fillMaxWidth().padding(14.dp),verticalArrangement=Arrangement.spacedBy(5.dp)){
   Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){ Text(q.name,color=Color.White,fontWeight=FontWeight.SemiBold); Text(q.status,color=if(q.status=="LIVE") Color(0xFF8FD6A8) else Color(0xFFFFB86B),fontSize=11.sp) }
   Text(q.price,color=gold,fontSize=23.sp,fontWeight=FontWeight.Bold); Text(q.symbol + "  •  " + q.unit + "  •  " + q.source,color=muted,fontSize=11.sp)
 } }
}

private fun fetchQuotes():List<QuoteUi>{
 val connection=URL(BuildConfig.API_BASE_URL+"/v1/market/quotes").openConnection() as HttpURLConnection
 connection.requestMethod="GET"; connection.connectTimeout=7000; connection.readTimeout=7000
 try { if(connection.responseCode !in 200..299) throw IllegalStateException("HTTP " + connection.responseCode)
   val body=connection.inputStream.bufferedReader().use{it.readText()}; val root=JSONObject(body); val arr=root.getJSONArray("quotes"); val result=mutableListOf<QuoteUi>()
   for(i in 0 until arr.length()){ val o=arr.getJSONObject(i); val p=if(o.isNull("price")) "—" else String.format(java.util.Locale.US,"%,.2f",o.getDouble("price")); result.add(QuoteUi(o.optString("symbol"),o.optString("name"),p,o.optString("unit"),o.optString("source"),o.optString("status"))) }
   return result
 } finally { connection.disconnect() }
}
