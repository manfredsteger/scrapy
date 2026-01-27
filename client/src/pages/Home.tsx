import { motion } from "framer-motion";
import { UploadCloud, Code2, ArrowRight } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-background to-secondary/20 overflow-hidden relative">
      
      {/* Abstract Background Element */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none opacity-40">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] bg-primary/10 rounded-full blur-3xl" />
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="max-w-3xl w-full text-center space-y-8 relative z-10"
      >
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/5 border border-primary/10 text-sm font-medium text-primary mb-4">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          System Ready
        </div>

        <h1 className="text-5xl md:text-7xl font-bold tracking-tighter text-foreground text-balance">
          Web Scraper <br/>
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-primary/60">
            Project
          </span>
        </h1>
        
        <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto leading-relaxed font-light">
          Ready for code import. Please upload your ZIP file to proceed with the initialization.
        </p>

        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="grid gap-4 w-full max-w-sm mx-auto mt-12"
        >
          <div className="group relative overflow-hidden rounded-2xl bg-card border border-border shadow-lg transition-all hover:shadow-xl hover:border-primary/20 p-8 flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
              <UploadCloud className="w-8 h-8 text-primary" />
            </div>
            
            <div className="space-y-2">
              <h3 className="font-semibold text-lg">Awaiting Import</h3>
              <p className="text-sm text-muted-foreground">
                Drop your project files here to begin analysis
              </p>
            </div>

            <button 
              className="mt-4 w-full py-3 px-4 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              onClick={() => {
                // Placeholder for future implementation
                alert("Upload functionality will be implemented in the next step.");
              }}
            >
              Upload Project ZIP <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </motion.div>

        <div className="pt-12 flex justify-center gap-8 text-muted-foreground opacity-60">
          <div className="flex items-center gap-2">
            <Code2 className="w-4 h-4" />
            <span className="text-xs uppercase tracking-widest">Next.js</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full border border-current flex items-center justify-center text-[10px] font-bold">TS</div>
            <span className="text-xs uppercase tracking-widest">TypeScript</span>
          </div>
          <div className="flex items-center gap-2">
             <div className="w-4 h-4 bg-current rounded-sm opacity-20" />
            <span className="text-xs uppercase tracking-widest">Analysis</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
